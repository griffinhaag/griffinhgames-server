export default {
  id: "reflex",
  name: "Reflex Game (placeholder)",

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
