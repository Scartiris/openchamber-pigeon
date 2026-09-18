const sendError = (res, error) => {
  console.error('[fleet]', error);
  res.status(500).json({
    error: error?.message || 'Fleet snapshot failed',
    code: error?.code || 'fleet_snapshot_failed',
  });
};

/**
 * Fleet routes live under the shared `/api` middleware, so UI session auth and
 * the usual redaction rules apply without any special casing here.
 */
export function registerFleetRoutes(app, { snapshotRuntime }) {
  // `?refresh=1` is the panel's explicit refresh button: it bypasses the TTL but
  // still joins an in-flight read rather than doubling device probes.
  app.get('/api/fleet/status', async (req, res) => {
    try {
      const refresh = req.query?.refresh;
      const force = refresh === '1' || refresh === 'true';
      res.json(await snapshotRuntime.read({ force }));
    } catch (error) {
      sendError(res, error);
    }
  });

  app.get('/api/fleet/host', async (_req, res) => {
    try {
      const snapshot = await snapshotRuntime.read({});
      res.json({
        checkedAt: snapshot.checkedAt,
        host: snapshot.host,
        summary: snapshot.summary,
      });
    } catch (error) {
      sendError(res, error);
    }
  });
}
