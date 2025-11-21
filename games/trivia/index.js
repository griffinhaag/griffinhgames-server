export default {
  id: "trivia",
  name: "Trivia Challenge",
  description: "Test your knowledge with friends in this exciting multiplayer trivia game!",
  minPlayers: 2,
  maxPlayers: 10,
  icon: "🧠",

  create({ io, room, roomManager }) {
    return {
      handleEvent({ eventName, payload, socketId }) {
        // Placeholder — implement gameplay later
      },

      getState() {
        return {};
      },

      teardown() {
        // Placeholder teardown
      }
    };
  }
};
