import reflexGame from "./reflex/index.js";
import triviaGame from "./trivia/index.js";

const gameRegistry = {
  reflex: reflexGame,
  trivia: triviaGame
};

export default gameRegistry;
