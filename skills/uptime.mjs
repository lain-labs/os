// Lain's first self-carried skill — also the living example of the format.
export default {
  name: "uptime",
  description:
    "Report how long the agent process has been alive and its memory footprint. Useful for 'haven't you restarted in a while?' style questions.",
  parameters: { type: "object", properties: {} },
  async handler() {
    const s = Math.floor(process.uptime());
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    const mem = Math.round(process.memoryUsage().rss / 1024 / 1024);
    const human = `${d ? `${d}d ` : ""}${h ? `${h}h ` : ""}${m}m`;
    return {
      ok: true,
      text: `alive for ${human}, ${mem} MB resident.`,
      data: { uptimeSeconds: s, rssMb: mem },
    };
  },
};
