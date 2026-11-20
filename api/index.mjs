import { createAppServer } from "../src/server.mjs";

let appInstance = null;

function getApp() {
  if (!appInstance) {
    appInstance = createAppServer();
  }
  return appInstance;
}

export default async function handler(req, res) {
  return getApp().requestHandler(req, res);
}
