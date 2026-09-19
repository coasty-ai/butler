import { contextBridge, ipcRenderer } from "electron";
import type { Bridge, KokoroUiStatus } from "../src/ui/api";
const invoke = (method: string, ...args: unknown[]) =>
  ipcRenderer.invoke("coarena", method, args);
const bridge: Bridge = {
  info: () => invoke("info"),
  saveSettings: (...a) => invoke("saveSettings", ...a),
  start: (...a) => invoke("start", ...a),
  pause: () => invoke("pause"),
  resume: () => invoke("resume"),
  stop: () => invoke("stop"),
  confirm: (...a) => invoke("confirm", ...a),
  history: () => invoke("history"),
  loadRun: (...a) => invoke("loadRun", ...a),
  deleteRun: (...a) => invoke("deleteRun", ...a),
  feedback: (...a) => invoke("feedback", ...a),
  review: (...a) => invoke("review", ...a),
  donate: (...a) => invoke("donate", ...a),
  withdraw: (...a) => invoke("withdraw", ...a),
  exportWorkflow: (...a) => invoke("exportWorkflow", ...a),
  permissions: () => invoke("permissions"),
  voicePermissions: () => invoke("voicePermissions"),
  command: (text) => invoke("command", text),
  openCommand: () => invoke("openCommand"),
  pillState: () => invoke("pillState"),
  dismiss: () => invoke("dismiss"),
  openSettings: (section) => invoke("openSettings", section),
  closeSettings: () => invoke("closeSettings"),
  memorySummary: () => invoke("memorySummary"),
  forgetMemory: () => invoke("forgetMemory"),
  // Settings window only: main rejects these from the pill overlay.
  voices: () => invoke("voices"),
  previewVoice: () => invoke("previewVoice"),
  openVoiceSettings: () => invoke("openVoiceSettings"),
  kokoroStatus: () => invoke("kokoroStatus"),
  downloadKokoro: (...a) => invoke("downloadKokoro", ...a),
  cancelKokoroDownload: () => invoke("cancelKokoroDownload"),
  removeKokoro: () => invoke("removeKokoro"),
  messagesStatus: () => invoke("messagesStatus"),
  agendaStatus: () => invoke("agendaStatus"),
  requestAgendaAccess: () => invoke("requestAgendaAccess"),
  sendTestMessage: () => invoke("sendTestMessage"),
  setupStatus: () => invoke("setupStatus"),
  openPrivacyPane: (pane) => invoke("openPrivacyPane", pane),
  relaunch: () => invoke("relaunch"),
  detectOllama: () => invoke("detectOllama"),
  checkProviderKey: (...a) => invoke("checkProviderKey", ...a),
  completeSetup: () => invoke("completeSetup"),
  remoteStatus: () => invoke("remoteStatus"),
  setRemoteDevice: (...a) => invoke("setRemoteDevice", ...a),
  forgetRemoteDevice: (...a) => invoke("forgetRemoteDevice", ...a),
  lockRemote: () => invoke("lockRemote"),
  toolsStatus: () => invoke("toolsStatus"),
  setAppleTool: (...a) => invoke("setAppleTool", ...a),
  addToolServer: (...a) => invoke("addToolServer", ...a),
  testToolServer: (...a) => invoke("testToolServer", ...a),
  approveToolServer: (...a) => invoke("approveToolServer", ...a),
  setToolServer: (...a) => invoke("setToolServer", ...a),
  setToolTicked: (...a) => invoke("setToolTicked", ...a),
  setToolSecret: (...a) => invoke("setToolSecret", ...a),
  forgetToolServer: (...a) => invoke("forgetToolServer", ...a),
  modulesStatus: () => invoke("modulesStatus"),
  recipesStatus: () => invoke("recipesStatus"),
  subscribePill: (fn) => {
    const handler = (_e: unknown, s: any) => fn(s);
    ipcRenderer.on("pill", handler);
    return () => ipcRenderer.removeListener("pill", handler);
  },
  subscribeView: (fn) => {
    const handler = (_e: unknown, s: string) => fn(s);
    ipcRenderer.on("view", handler);
    return () => ipcRenderer.removeListener("view", handler);
  },
  subscribeKokoro: (fn) => {
    const handler = (_e: unknown, s: KokoroUiStatus) => fn(s);
    ipcRenderer.on("kokoro-status", handler);
    return () => ipcRenderer.removeListener("kokoro-status", handler);
  },
  subscribe: (fn) => {
    const handler = (_e: unknown, s: any) => fn(s);
    ipcRenderer.on("snapshot", handler);
    return () => ipcRenderer.removeListener("snapshot", handler);
  },
};
contextBridge.exposeInMainWorld("coarena", bridge);
