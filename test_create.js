const { io } = require('socket.io-client');
const socket = io('http://localhost:3000');
socket.on('connect', () => {
  console.log('Connected');
  socket.emit('create_game', {}, (res) => {
    console.log('Create game response:', res);
    process.exit(0);
  });
});
