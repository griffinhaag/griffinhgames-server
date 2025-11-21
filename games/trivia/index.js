export default {
  id: "trivia",
  name: "Trivia Game (placeholder)",

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
