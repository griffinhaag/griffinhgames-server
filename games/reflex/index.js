export default {
  id: "reflex",
  name: "Reflex Challenge",
  description: "Test your reaction speed and reflexes in this fast-paced multiplayer game!",
  minPlayers: 2,
  maxPlayers: 8,
  icon: "⚡",

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
