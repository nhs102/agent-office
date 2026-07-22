import { supervise } from "./supervisor";

supervise([
  ["npm", "run", "start"],
  ["npm", "run", "start:office"],
]);
