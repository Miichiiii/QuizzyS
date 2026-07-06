const io = require('socket.io-client');

const host = io('http://localhost:3000');
const p1 = io('http://localhost:3000');
const p2 = io('http://localhost:3000');
const tv = io('http://localhost:3000');

let roomCode;

host.on('connect', () => {
  host.emit('create_game', { origin: 'http://localhost:3000' }, res => {
    roomCode = res.code;
    console.log('Host created game:', roomCode);
    
    // TV joins
    tv.emit('join_as_spectator', { code: roomCode });
    tv.on('tv_state', state => console.log('TV got state:', state.view));
    tv.on('tv_lobby', data => console.log('TV got tv_lobby'));
    tv.on('tv_category_select', data => console.log('TV got tv_category_select'));
    tv.on('tv_question', data => console.log('TV got tv_question', data.question.question));
    
    // Players join
    p1.emit('join_game', { code: roomCode, name: 'P1' }, res => {
      console.log('P1 joined', res.color);
      p2.emit('join_game', { code: roomCode, name: 'P2' }, res => {
        console.log('P2 joined', res.color);
        
        // Host starts game
        host.emit('start_game', { code: roomCode }, res => {
          console.log('Host started game:', res);
        });
      });
    });
  });
});

p1.on('category_select', data => {
  console.log('P1 got category_select', data.categories);
  p1.emit('select_category', { code: roomCode, category: data.categories[0] }, res => {
    console.log('P1 selected category:', res);
  });
});

p1.on('next_question', data => {
  console.log('P1 got next_question', data.question);
  setTimeout(() => process.exit(0), 1000);
});
