import { supervise } from "./supervisor";

supervise([
  ["npm", "run", "dev"],
  ["npm", "run", "dev:office"],
]);
