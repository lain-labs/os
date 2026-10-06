import { isOperator, writeSettings } from "../../system/settings.js";
import { describeNetworks, currentProfile, saveNetwork, slug, switchNetwork } from "../networks.js";
import type { Action } from "../../../types.js";

export const listNetworksAction: Action = {
  name: "list_networks",
  similes: ["networks", "show_networks", "which_network"],
  description: "List the chain profiles Lain knows (built-in and saved) and which one is active.",
  parameters: { type: "object", properties: {} },
  examples: [{ user: "на какой ты сети?", agent: "смотрю." }],
  async validate() {
    return true;
  },
  async handler(runtime) {
    return { ok: true, text: await describeNetworks(runtime) };
  },
};

export const switchNetworkAction: Action = {
  name: "switch_network",
  similes: ["set_network", "change_network", "use_network", "change_chain", "switch_chain"],
  description:
    "Move Lain's active chain to another network in one step: writes every CHAIN_* setting of the named profile " +
    "(see list_networks — e.g. robinhood, robinhood-testnet, cyberia, or a saved one), rebuilds the chain tools without a restart " +
    "and proves the RPC answers. The current configuration is saved as a profile first, so switching back loses nothing. " +
    "When the operator asks to change the network, call this directly — their request is the confirmation. " +
    "Pass save_as instead of name to save the current configuration under a name.",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "Profile name, chain id, or a loose name like 'robinhood mainnet'." },
      save_as: { type: "string", description: "Save the current CHAIN_* configuration as this profile name (no switch)." },
    },
  },
  examples: [{ user: "переключись на мейннет робинхуда", agent: "переключаю." }],
  async validate() {
    return true;
  },
  async handler(runtime, state, params) {
    if (!isOperator(state, runtime.getSetting("TELEGRAM_ALLOWED_USERS"))) {
      return { ok: false, text: "Only the operator can move me to another network." };
    }
    const saveAs = params.save_as ? slug(String(params.save_as)) : "";
    if (saveAs) {
      const current = currentProfile(runtime);
      if (!current) return { ok: false, text: "No chain is configured, so there is nothing to save." };
      await saveNetwork(runtime, { ...current, name: saveAs });
      return { ok: true, text: `saved the current network (${current.title}) as "${saveAs}".` };
    }
    const name = String(params.name ?? "").trim();
    if (!name) return { ok: true, text: await describeNetworks(runtime) };
    const res = await switchNetwork(runtime, name, writeSettings);
    return {
      ok: res.ok,
      text: res.text,
      data: res.to ? { network: res.to.name, chainId: res.to.chainId } : undefined,
    };
  },
};
