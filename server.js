const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
  maxHttpBufferSize: 1e7
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const rooms = {};

// Accurate Haversine Distance (meters)
function getDistanceMeters(lat1, lon1, lat2, lon2) {
  if (lat1 === undefined || lon1 === undefined || lat2 === undefined || lon2 === undefined) return 999999;
  const R = 6371e3; // Earth radius in meters
  const rad = Math.PI / 180;
  const p1 = lat1 * rad;
  const p2 = lat2 * rad;
  const dp = (lat2 - lat1) * rad;
  const dl = (lon2 - lon1) * rad;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

io.on('connection', (socket) => {
  let currentRoom = null;

  // 1. Create Room (Host) - Limit 50
  socket.on('create_room', (data) => {
    const roomCode = data.roomCode || `CAMPUS-${Math.floor(1000 + Math.random() * 9000)}`;
    currentRoom = roomCode;
    socket.join(roomCode);

    rooms[roomCode] = {
      code: roomCode,
      hostId: socket.id,
      started: false,
      paused: false,
      center: null,
      initialRadius: 500,
      currentRadius: 500,
      minRadius: 50,
      settings: data.settings || {},
      maxPlayers: 50, // Updated max limit to 50
      minPlayersToStart: 2,
      taskPhotos: [],
      eliminationPhotos: [],
      rematchVotes: {},
      gameInterval: null,
      shrinkInterval: null,
      gameSecondsRemaining: 0,
      runUpSecondsRemaining: 0,
      runUpActive: false,
      players: {
        [socket.id]: {
          id: socket.id,
          callsign: data.callsign || 'HOST_LEADER',
          role: 'hider',
          isProtector: false,
          isImmuneUntil: 0,
          lat: data.lat || 0,
          lng: data.lng || 0,
          isCaught: false,
          catches: 0,
          tasksCompleted: 0,
          outOfBoundsSince: null,
          usedPerks: {},
          totalPerksUsed: 0
        }
      },
      pulseActive: false
    };

    socket.emit('room_created', { 
      roomCode, 
      player: rooms[roomCode].players[socket.id], 
      settings: rooms[roomCode].settings 
    });
    io.to(roomCode).emit('lobby_update', Object.values(rooms[roomCode].players));
  });

  // 2. Join Room (Operative) - Up to 50 players
  socket.on('join_room', ({ roomCode, callsign }) => {
    const room = rooms[roomCode];
    if (!room) return socket.emit('error_msg', 'Room not found. Check code.');
    if (room.started) return socket.emit('error_msg', 'Match already in progress!');
    if (Object.keys(room.players).length >= room.maxPlayers) {
      return socket.emit('error_msg', 'Room is full (Maximum 50 operatives reached).');
    }

    currentRoom = roomCode;
    socket.join(roomCode);

    const existing = Object.values(room.players);
    const seekerCount = existing.filter(p => p.role === 'seeker').length;
    const targetSeekers = room.settings.seekerQuota || 2;
    const assignedRole = (seekerCount < targetSeekers) ? 'seeker' : 'hider';

    room.players[socket.id] = {
      id: socket.id,
      callsign: callsign || `AGENT_${socket.id.slice(0, 4)}`,
      role: assignedRole,
      isProtector: false,
      isImmuneUntil: 0,
      lat: 0,
      lng: 0,
      isCaught: false,
      catches: 0,
      tasksCompleted: 0,
      outOfBoundsSince: null,
      usedPerks: {},
      totalPerksUsed: 0
    };

    socket.emit('joined_successfully', {
      roomCode,
      player: room.players[socket.id],
      settings: room.settings
    });

    io.to(roomCode).emit('lobby_update', Object.values(room.players));
  });

  // 3. Start Game With Timers & Run-up
  socket.on('start_game', ({ hostLat, hostLng }) => {
    const room = rooms[currentRoom];
    if (!room || room.hostId !== socket.id) return;

    room.started = true;
    room.paused = false;
    room.taskPhotos = [];
    room.eliminationPhotos = [];
    room.rematchVotes = {};

    if (hostLat && hostLng) {
      room.center = { lat: hostLat, lng: hostLng };
    } else {
      const hostP = room.players[socket.id];
      if (hostP && hostP.lat) {
        room.center = { lat: hostP.lat, lng: hostP.lng };
      }
    }

    room.initialRadius = parseInt(room.settings.zoneRadius || 500);
    room.currentRadius = room.initialRadius;
    room.minRadius = parseInt(room.settings.minShrinkRadius || 60);

    Object.values(room.players).forEach(p => {
      p.isCaught = false;
      p.catches = 0;
      p.tasksCompleted = 0;
      p.isImmuneUntil = 0;
      p.outOfBoundsSince = null;
      p.usedPerks = {};
      p.totalPerksUsed = 0;
      p.isProtector = false;
    });

    const runUpDuration = parseInt(room.settings.runUpTimeSec || 30);
    const matchDuration = parseInt(room.settings.gameDurationMin || 15) * 60;
    room.gameSecondsRemaining = matchDuration;
    room.runUpSecondsRemaining = runUpDuration;
    room.runUpActive = runUpDuration > 0;

    io.to(currentRoom).emit('game_started', {
      settings: room.settings,
      center: room.center,
      currentRadius: room.currentRadius,
      players: Object.values(room.players),
      runUpActive: room.runUpActive,
      runUpSeconds: room.runUpSecondsRemaining,
      gameSeconds: room.gameSecondsRemaining
    });

    clearInterval(room.gameInterval);
    clearInterval(room.shrinkInterval);

    // Global match tick timer
    room.gameInterval = setInterval(() => {
      if (!rooms[room.code] || !room.started) {
        clearInterval(room.gameInterval);
        return;
      }
      if (room.paused) return;

      if (room.runUpActive) {
        room.runUpSecondsRemaining--;
        io.to(room.code).emit('runup_tick', { secondsLeft: room.runUpSecondsRemaining });
        if (room.runUpSecondsRemaining <= 0) {
          room.runUpActive = false;
          io.to(room.code).emit('runup_ended', { msg: '🚨 RUN-UP EXPIRED! SEEKERS ARE RELEASED!' });
        }
      } else {
        room.gameSecondsRemaining--;
        io.to(room.code).emit('game_timer_tick', { secondsLeft: room.gameSecondsRemaining });

        if (room.gameSecondsRemaining <= 0) {
          clearInterval(room.gameInterval);
          clearInterval(room.shrinkInterval);
          io.to(room.code).emit('game_over', {
            winner: 'HIDERS',
            reason: 'Mission time expired! Hiders successfully survived!',
            standings: Object.values(room.players),
            photos: room.taskPhotos,
            eliminations: room.eliminationPhotos
          });
        }
      }
    }, 1000);

    // Shrinking Zone Engine
    if (room.settings.shrinkingZone) {
      const shrinkEverySec = parseInt(room.settings.shrinkIntervalSec || 60);
      const shrinkStepMeters = parseInt(room.settings.shrinkAmountMeters || 30);

      room.shrinkInterval = setInterval(() => {
        if (!rooms[room.code] || !room.started || room.paused || room.runUpActive) return;

        if (room.currentRadius > room.minRadius) {
          room.currentRadius = Math.max(room.minRadius, room.currentRadius - shrinkStepMeters);
          io.to(room.code).emit('zone_shrunk', {
            newRadius: room.currentRadius,
            message: `⚠️ Zone boundary contracted by ${shrinkStepMeters}m! Current radius: ${room.currentRadius}m`
          });
        }
      }, shrinkEverySec * 1000);
    }
  });

  // 4. Force End Game (Host only, anytime)
  socket.on('host_end_game', () => {
    const room = rooms[currentRoom];
    if (!room || room.hostId !== socket.id || !room.started) return;

    clearInterval(room.gameInterval);
    clearInterval(room.shrinkInterval);
    room.started = false;

    io.to(currentRoom).emit('game_over', {
      winner: 'ABORTED',
      reason: 'The match was ended by the host.',
      standings: Object.values(room.players),
      photos: room.taskPhotos,
      eliminations: room.eliminationPhotos
    });
  });

  // 5. Host Pause & Resume
  socket.on('toggle_pause_game', () => {
    const room = rooms[currentRoom];
    if (!room || room.hostId !== socket.id || !room.started) return;

    room.paused = !room.paused;
    io.to(currentRoom).emit('game_pause_state', {
      paused: room.paused,
      byHost: room.players[socket.id].callsign
    });
  });

  // 6. GPS Updates & Accurate Distance Detection
  socket.on('send_gps', ({ lat, lng }) => {
    const room = rooms[currentRoom];
    if (!room || !room.players[socket.id] || room.paused) return;

    const me = room.players[socket.id];
    me.lat = lat;
    me.lng = lng;

    const elimRadius = parseFloat(room.settings.catchRadius || 10);
    const now = Date.now();

    // Seeker targeting logic with exact meter validation
    if (me.role === 'seeker' && !room.runUpActive) {
      let targetInScope = null;
      let targetDist = 999999;

      Object.values(room.players).forEach(other => {
        if (other.role === 'hider' && !other.isCaught) {
          const d = getDistanceMeters(me.lat, me.lng, other.lat, other.lng);
          if (d <= elimRadius && d < targetDist) {
            const isImmune = other.isImmuneUntil && other.isImmuneUntil > now;
            targetDist = d;
            targetInScope = {
              id: other.id,
              name: other.callsign,
              distance: parseFloat(d.toFixed(1)),
              isImmune: isImmune,
              immuneRemaining: isImmune ? Math.ceil((other.isImmuneUntil - now) / 1000) : 0
            };
          }
        }
      });

      socket.emit('target_scope_update', targetInScope);
    }

    // Proximity klaxon alert (<50m)
    if (me.role === 'hider' && !me.isCaught) {
      let minSeekerDist = 999999;
      Object.values(room.players).forEach(other => {
        if (other.role === 'seeker') {
          const d = getDistanceMeters(me.lat, me.lng, other.lat, other.lng);
          if (d < minSeekerDist) minSeekerDist = d;
        }
      });

      if (minSeekerDist <= 50) {
        socket.emit('proximity_alert', { distance: parseFloat(minSeekerDist.toFixed(1)) });
      }
    }

    // Out of Zone boundary checking against dynamic shrinking radius
    if (room.center && room.center.lat && !me.isCaught) {
      const distFromCenter = getDistanceMeters(me.lat, me.lng, room.center.lat, room.center.lng);
      const zoneLimit = room.currentRadius || 500;
      const graceSeconds = parseInt(room.settings.gracePeriodSec || 10);

      if (distFromCenter > zoneLimit) {
        if (!me.outOfBoundsSince) me.outOfBoundsSince = now;
        const secondsOut = Math.floor((now - me.outOfBoundsSince) / 1000);
        const rem = Math.max(0, graceSeconds - secondsOut);
        socket.emit('zone_warning', { secondsRemaining: rem, isOutOfBounds: true });

        if (secondsOut >= graceSeconds) {
          executeElimination(room, me, `Eliminated: Stayed outside play boundary for ${graceSeconds}s!`, null);
        }
      } else {
        if (me.outOfBoundsSince) {
          me.outOfBoundsSince = null;
          socket.emit('zone_warning', { isOutOfBounds: false });
        }
      }
    }

    broadcastTacticalTelemetry(room);
  });

  // 7. Elimination Trigger - Strict Distance Enforcement
  socket.on('direct_eliminate_target', ({ targetHiderId }) => {
    const room = rooms[currentRoom];
    if (!room || !room.players[socket.id] || room.paused || room.runUpActive) return;

    const seeker = room.players[socket.id];
    const target = room.players[targetHiderId];

    if (!seeker || seeker.role !== 'seeker' || !target || target.role !== 'hider' || target.isCaught) return;

    if (target.isImmuneUntil && target.isImmuneUntil > Date.now()) {
      return socket.emit('error_msg', `CANNOT TAG! ${target.callsign} is protected by a Guardian Shield!`);
    }

    const maxAllowed = parseFloat(room.settings.catchRadius || 10) + 2.0;
    const dist = getDistanceMeters(seeker.lat, seeker.lng, target.lat, target.lng);
    if (dist > maxAllowed) {
      return socket.emit('error_msg', `Target escaped! Distance is ${dist.toFixed(1)}m (Allowed limit: ${room.settings.catchRadius}m)`);
    }

    executeElimination(room, target, `Tagged by ${seeker.callsign}`, seeker);
  });

  socket.on('confirm_photo_elimination', ({ targetHiderId, photoData }) => {
    const room = rooms[currentRoom];
    if (!room || !room.players[socket.id] || room.paused || room.runUpActive) return;

    const seeker = room.players[socket.id];
    const target = room.players[targetHiderId];

    if (!seeker || seeker.role !== 'seeker' || !target || target.role !== 'hider' || target.isCaught) return;

    if (target.isImmuneUntil && target.isImmuneUntil > Date.now()) {
      return socket.emit('error_msg', `CANNOT ELIMINATE! ${target.callsign} has Guardian Immunity!`);
    }

    const maxAllowed = parseFloat(room.settings.catchRadius || 10) + 4.0;
    const dist = getDistanceMeters(seeker.lat, seeker.lng, target.lat, target.lng);
    if (dist > maxAllowed) {
      return socket.emit('error_msg', `Out of photo range! Distance is ${dist.toFixed(1)}m`);
    }

    const elimRecord = {
      seeker: seeker.callsign,
      target: target.callsign,
      photoData: photoData,
      time: new Date().toLocaleTimeString().slice(3, 8)
    };
    room.eliminationPhotos.push(elimRecord);

    executeElimination(room, target, `Photo tagged by ${seeker.callsign}`, seeker, photoData);
  });

  function executeElimination(room, target, reason, seeker = null, photoData = null) {
    if (target.isCaught) return;
    target.isCaught = true;

    if (seeker) seeker.catches = (seeker.catches || 0) + 1;

    let convertedToSeeker = false;
    if (room.settings.enableInfected && seeker) {
      target.role = 'seeker';
      target.isCaught = false;
      convertedToSeeker = true;
      io.to(target.id).emit('converted_to_seeker', {
        msg: "☣️ INFECTION MODE: You have turned into a Seeker! Hunt the runners!"
      });
    } else {
      io.to(target.id).emit('you_are_eliminated', {
        reason: reason,
        bySeeker: seeker ? seeker.callsign : 'BOUNDARY ALARM',
        photoData: photoData,
        canSpectate: true,
        canUseShield: !room.settings.enableInfected
      });
    }

    io.to(room.code).emit('player_officially_eliminated', {
      seekerName: seeker ? seeker.callsign : 'SYSTEM',
      targetName: target.callsign,
      targetId: target.id,
      totalCatches: seeker ? seeker.catches : 0,
      convertedToSeeker: convertedToSeeker,
      reason: reason
    });

    const remainingHiders = Object.values(room.players).filter(p => p.role === 'hider' && !p.isCaught);
    if (remainingHiders.length === 0) {
      clearInterval(room.gameInterval);
      clearInterval(room.shrinkInterval);
      io.to(room.code).emit('game_over', {
        winner: 'SEEKERS',
        reason: 'All hiders have been found and eliminated!',
        standings: Object.values(room.players),
        photos: room.taskPhotos,
        eliminations: room.eliminationPhotos
      });
    }
  }

  // 8. Shield: ONLY Eliminated People Can Use It
  socket.on('activate_guardian_shield', ({ targetHiderId }) => {
    const room = rooms[currentRoom];
    if (!room || !room.players[socket.id] || room.paused) return;

    if (room.settings.enableInfected) {
      return socket.emit('error_msg', 'Guardian Shield is completely disabled in Infection Mode!');
    }

    const caster = room.players[socket.id];
    if (!caster.isCaught) {
      return socket.emit('error_msg', 'Only eliminated players (Spectator Angels) can cast Guardian Shield!');
    }

    const target = room.players[targetHiderId];
    if (!target || target.isCaught || target.role !== 'hider') {
      return socket.emit('error_msg', 'Invalid target. Can only shield active living hiders.');
    }

    target.isImmuneUntil = Date.now() + 60000;

    io.to(currentRoom).emit('guardian_shield_activated', {
      guardianName: caster.callsign,
      targetName: target.callsign,
      targetId: target.id,
      duration: 60
    });
  });

  // 9. Single-Use Perks with Match Perk Allowance
  socket.on('use_perk', ({ perkId }) => {
    const room = rooms[currentRoom];
    if (!room || !room.players[socket.id] || room.paused) return;

    const me = room.players[socket.id];
    const maxPerksAllowed = parseInt(room.settings.maxPerksPerMatch || 1);

    if (maxPerksAllowed !== 0 && me.totalPerksUsed >= maxPerksAllowed) {
      return socket.emit('error_msg', `Perk limit reached! You can only use ${maxPerksAllowed} perk(s) per match.`);
    }

    if (me.usedPerks[perkId]) {
      return socket.emit('error_msg', `Perk [${perkId.toUpperCase()}] has already been consumed!`);
    }

    me.usedPerks[perkId] = true;
    me.totalPerksUsed++;

    if (perkId === 'uav') {
      room.pulseActive = true;
      io.to(currentRoom).emit('pulse_state', { active: true, duration: 10 });
      broadcastTacticalTelemetry(room);
      setTimeout(() => {
        if (rooms[room.code]) {
          rooms[room.code].pulseActive = false;
          io.to(room.code).emit('pulse_state', { active: false });
          broadcastTacticalTelemetry(rooms[room.code]);
        }
      }, 10000);
    }

    socket.emit('perk_consumed', {
      perkId,
      remainingPerks: maxPerksAllowed === 0 ? 'Unlimited' : Math.max(0, maxPerksAllowed - me.totalPerksUsed)
    });
  });

  // 10. Photo Tasks
  socket.on('submit_task_photo', ({ taskId, taskTitle, photoData }) => {
    const room = rooms[currentRoom];
    if (!room || !room.players[socket.id] || room.paused) return;

    const me = room.players[socket.id];
    me.tasksCompleted = (me.tasksCompleted || 0) + 1;

    const evidence = {
      taskId,
      taskTitle,
      photoData,
      uploader: me.callsign,
      time: new Date().toLocaleTimeString().slice(3, 8)
    };
    room.taskPhotos.push(evidence);

    const totalHiders = Object.values(room.players).filter(p => p.role === 'hider');
    const totalRequired = (room.settings.taskCount || 2) * (totalHiders.length || 1);
    const totalDone = totalHiders.reduce((acc, h) => acc + (h.tasksCompleted || 0), 0);

    if (totalDone >= totalRequired && totalRequired > 0) {
      clearInterval(room.gameInterval);
      clearInterval(room.shrinkInterval);
      io.to(currentRoom).emit('game_over', {
        winner: 'HIDERS',
        reason: 'Extraction quota complete! All task landmarks photographed and verified!',
        standings: Object.values(room.players),
        photos: room.taskPhotos,
        eliminations: room.eliminationPhotos
      });
    }
  });

  // Rematch & Clean Disconnect
  socket.on('vote_rematch', () => {
    const room = rooms[currentRoom];
    if (!room) return;
    room.rematchVotes[socket.id] = true;
    const votedNames = Object.keys(room.rematchVotes).map(id => room.players[id]?.callsign).filter(Boolean);
    io.to(currentRoom).emit('rematch_roster_update', {
      votedList: votedNames,
      totalVoted: votedNames.length,
      totalNeeded: Object.keys(room.players).length
    });
  });

  socket.on('request_rematch', () => {
    const room = rooms[currentRoom];
    if (!room) return;
    clearInterval(room.gameInterval);
    clearInterval(room.shrinkInterval);
    room.started = false;
    room.paused = false;
    room.taskPhotos = [];
    room.eliminationPhotos = [];
    room.rematchVotes = {};

    Object.values(room.players).forEach(p => {
      p.isCaught = false;
      p.catches = 0;
      p.tasksCompleted = 0;
      p.isImmuneUntil = 0;
      p.outOfBoundsSince = null;
      p.usedPerks = {};
      p.totalPerksUsed = 0;
    });

    io.to(currentRoom).emit('return_to_lobby', {
      roomCode: room.code,
      players: Object.values(room.players),
      settings: room.settings
    });
  });

  socket.on('send_chat', (text) => {
    const room = rooms[currentRoom];
    if (!room || !room.players[socket.id]) return;
    io.to(currentRoom).emit('chat_message', {
      sender: room.players[socket.id].callsign,
      role: room.players[socket.id].role,
      text: text,
      time: new Date().toLocaleTimeString().slice(3, 8)
    });
  });

  socket.on('disconnect', () => {
    if (currentRoom && rooms[currentRoom]) {
      delete rooms[currentRoom].players[socket.id];
      delete rooms[currentRoom].rematchVotes[socket.id];
      io.to(currentRoom).emit('lobby_update', Object.values(rooms[currentRoom].players));
      if (Object.keys(rooms[currentRoom].players).length === 0) {
        clearInterval(rooms[currentRoom].gameInterval);
        clearInterval(rooms[currentRoom].shrinkInterval);
        delete rooms[currentRoom];
      }
    }
  });
});

function broadcastTacticalTelemetry(room) {
  const players = Object.values(room.players);
  players.forEach(client => {
    let visible = [];
    if (client.role === 'hider') {
      visible = players
        .filter(p => p.role === 'hider')
        .map(p => ({
          id: p.id,
          name: p.callsign,
          role: p.role,
          lat: p.lat,
          lng: p.lng,
          isCaught: p.isCaught,
          isImmune: p.isImmuneUntil > Date.now()
        }));
    } else if (client.role === 'seeker') {
      visible = players
        .filter(p => p.role === 'seeker' || (p.role === 'hider' && room.pulseActive && !p.isCaught))
        .map(p => ({
          id: p.id,
          name: p.callsign,
          role: p.role,
          lat: p.lat,
          lng: p.lng,
          isCaught: p.isCaught,
          isImmune: p.isImmuneUntil > Date.now()
        }));
    }
    io.to(client.id).emit('radar_sync', visible);
  });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`MAN-HUNT Tactical Server online on port ${PORT}`);
});
