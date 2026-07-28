import { runRefresh } from "./lib/refresh.mjs";

export default async () => {
  await runRefresh((msg) => console.log(msg));
  return new Response("ok");
};

export const config = { schedule: "@daily" };
