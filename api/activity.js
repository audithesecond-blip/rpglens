import { createClient } from "@supabase/supabase-js";

// ═══════════════════════════════════════════════════════════════════
// USER ACTIVITY — api/activity.js
//
// Backend for cross-device history. Replaces the localStorage-only
// history that disappeared between devices and browsers.
//
// POST /api/activity with { op: 'log', ... }   → insert a new entry
// POST /api/activity with { op: 'list', ... }  → read back recent entries
// ═══════════════════════════════════════════════════════════════════

const VALID_ACTIONS = new Set(["analysis", "conversion", "spool"]);

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "https://rpglens.vercel.app");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")    return res.status(405).json({ error: "Method not allowed" });

  try {
    // Auth
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Not authenticated" });
    }
    const token = authHeader.split(" ")[1];
    const sb    = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const { data: { user }, error: authError } = await sb.auth.getUser(token);
    if (authError || !user) {
      return res.status(401).json({ error: "Session expired" });
    }

    const { op } = req.body || {};

    // ── LOG ────────────────────────────────────────────────────────
    if (op === "log") {
      const {
        action, program, lines, rluCost, source, metadata, resultRef
      } = req.body;

      if (!VALID_ACTIONS.has(action)) {
        return res.status(400).json({ error: "Invalid action type" });
      }

      const row = {
        user_id:    user.id,
        action,
        program:    (program || "").slice(0, 200) || null,
        lines:      Number.isFinite(+lines)    ? +lines    : null,
        rlu_cost:   Number.isFinite(+rluCost)  ? +rluCost  : null,
        source:     source  || null,
        metadata:   metadata && typeof metadata === "object" ? metadata : null,
        result_ref: resultRef || null
      };

      const { data, error } = await sb.from("user_activity").insert(row).select().single();
      if (error) {
        console.error("activity log error:", error);
        return res.status(500).json({ error: "Could not save activity" });
      }
      return res.status(200).json({ ok: true, id: data.id });
    }

    // ── LIST ───────────────────────────────────────────────────────
    if (op === "list") {
      const { action, limit } = req.body;
      const max = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);

      let query = sb.from("user_activity")
        .select("id, action, program, lines, rlu_cost, source, metadata, result_ref, created_at")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false })
        .limit(max);

      if (action && VALID_ACTIONS.has(action)) query = query.eq("action", action);

      const { data, error } = await query;
      if (error) {
        console.error("activity list error:", error);
        return res.status(500).json({ error: "Could not load activity" });
      }

      return res.status(200).json({ activities: data || [] });
    }

    return res.status(400).json({ error: "Invalid op. Expected 'log' or 'list'." });

  } catch (err) {
    console.error("activity endpoint error:", err);
    return res.status(500).json({ error: "Activity service error" });
  }
}
