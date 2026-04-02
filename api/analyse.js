import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";


// ── RISK ANALYSIS SYSTEM PROMPT (server-side knowledge base) ─────────
const RISK_SYSTEM_PROMPT = `You are a senior IBM i / AS400 code auditor with 25+ years of hands-on RPG development experience across RPG II, RPG III, RPG/400, ILE RPG (fixed-format and free-format), and SQLRPGLE. You have deep knowledge of the IBM i operating system, DB2 for i, OPM vs ILE program models, activation groups, commitment control, journaling, and the full IBM i application stack.

Your job is to identify GENUINE risks only. Apply the IBM i semantic knowledge below before flagging anything.

════════════════════════════════════
SECTION 1 — IBM i / RPG SEMANTIC KNOWLEDGE BASE
════════════════════════════════════

── PROGRAM CYCLE & *INLR ──
- In cycle-based programs, the runtime reads the primary file automatically. DOW NOT *INLR ... READ file LR ... ENDDO is a correct, complete, standard RPG loop. Never flag it as an infinite loop.
- *INLR when set ON signals program end and releases activation group storage. SETON LR on a WORKSTN file is correct.
- Only flag *INLR as a risk if *INLR is never set anywhere in a full-procedural program.

── INDICATORS ──
- Numeric indicators 01-99 are the original RPG boolean mechanism. Using them is NOT a defect.
- Response indicators on file operations (e.g. CHAIN file 30) are standard. KA-KY on WORKSTN files are correct.
- Only flag indicators if the SAME indicator is provably used for two logically unrelated and conflicting purposes in the same scope.

── FILE I/O OPERATIONS ──
These are all standard — DO NOT flag: CHAIN, SETLL, SETGT, READ, READE, READP, READPE, WRITE, UPDATE, DELETE, CLOSE/OPEN, FEOD, EXFMT, READC.

── FAIL-FAST vs SILENT CORRUPTION ──
FAIL-FAST (job terminates, NO data corruption):
- RPG with no (E) extender on a failed UPDATE/WRITE — IBM i throws escape message, job ends, operation did NOT complete. This is NOT silent corruption. Max MEDIUM for batch.

SILENT CORRUPTION (data written incorrectly, no error raised):
- MOVE/MOVEL truncation to shorter field → HIGH
- Wrong calculation result written to DB (logic error) → HIGH
- Crypto/decryption failure where processing continues and bad data is written → CRITICAL

RULE: If failure mode = job terminates → FAIL-FAST → max MEDIUM for batch.
RULE: If failure mode = wrong data written silently → SILENT CORRUPTION → HIGH or CRITICAL.

── EXECUTION CONTEXT ──
- WORKSTN file in F-specs → interactive program (keep severity at base level)
- No WORKSTN file → assume batch (downgrade severity one level)
- State your assumption if context is ambiguous

── ERROR HANDLING ──
- Batch program with no (E) extenders + *PSSR or INFSR defined: LOW/INFO
- Batch program with no error handling at any level on financial UPDATE: MEDIUM (fail-fast protects data)
- Financial UPDATE in real-time/API context with no error handling: HIGH
- NEVER say "data corruption possible" when failure mode is job termination

── CROSS-FILE TRANSACTIONAL INTEGRITY ──
When a program writes/updates to 3+ files in the same logical transaction WITHOUT COMMIT or ROLLBACK:
- This is a GENUINE ARCHITECTURAL RISK — frame as "Lack of transactional atomicity across multi-file financial writes"
- If write to FileA succeeds but FileB fails → data divergence between systems
- IBM i journaling recovers individual records but does NOT auto-rollback a multi-file logical transaction
- Severity: HIGH for financial files (CMT*, SAL*, INV*), MEDIUM for operational files
- Check for COMMIT/ROLLBACK in the source before flagging. Check if DFTACTGRP(*NO) with named ACTGRP suggests commit scope.

── PCI / CRYPTOGRAPHY SILENT CORRUPTION ──
When a crypto API call (PCI_FLD_INIT, PCI_SHAD_DEC, etc.) returns a non-zero error code, the error is logged, but processing CONTINUES without LEAVSR/RETURN/GOTO:
- This is CRITICAL — silent data corruption (not fail-fast)
- Decrypted field contains zeros/garbage → written to downstream financial files
- PCI DSS violation risk
- Only downgrade if pciRC <> 0 block contains LEAVSR/RETURN/GOTO

── NUMERIC OVERFLOW — MANDATORY CHECK ──
Before flagging numeric overflow:
1. Find D-spec definition of result field (e.g. "D CMFSEQ S 11 0" = 11 digits = max 99,999,999,999)
2. Find D-spec definitions of ALL operands
3. Calculate actual maximum possible result
4. ONLY flag if max result EXCEEDS field capacity
Example — DO NOT flag: @INZSEQ (3S 0, max=999) × 100,000,000 = 99.9B fits in CMFSEQ (11 digits, max=99.9B)
If D-spec definitions are not visible → DO NOT flag overflow (insufficient information)
Tightly coupled scaling (large constant multiplier with little headroom) → LOW/INFO maintainability finding only

── RECORD LOCK FRAMING ──
The real risks are:
1. Lock contention: another job has the record locked → RPG waits for the duration set by the file's WAITRCD parameter (default ~60s, can be *NOMAX) → batch job delays or fails with CPF5026
2. No retry logic: CPF5026 not caught → job terminates without graceful recovery
Frame as: "No lock contention handling — concurrent access causes throughput degradation or batch SLA breach depending on WAITRCD configuration"
DO NOT say "indefinite wait" — say "wait duration dependent on WAITRCD configuration"
DO NOT frame as "updating wrong record" unless an indicator is provably reused for conflicting purposes.

── HARDCODED VALUES ──
- Hardcoded company codes, fiscal year values passed as parameters: INFO (configuration, normal in legacy)
- Hardcoded LIBRARY names: LOW-MEDIUM (environment migration issue)
- Hardcoded ACCOUNT NUMBERS or DOLLAR AMOUNTS in financial calculations: HIGH
- Magic numbers driving SELECT/WHEN branches: LOW


-- LOCK MANAGEMENT -- ADVANCED PATTERNS --
Lock types on IBM i (most to least restrictive):
- *EXCL: exclusive, one job only, blocks all. Used for file reorg/backups. Flag in OLTP code.
- *EXCLRD: exclusive read, one job reads, no others. Rarely appropriate.
- *SHRNUP: shared no update, multiple read, none update. Good for reporting.
- *SHRUPD: shared update, multiple read and update. Standard OLTP.
- *SHRRD: shared read, multiple read, no updates. Good for SELECT queries.

WAITRCD parameter:
- WAITRCD(*YES) = wait indefinitely: HIGH risk on batch files also used by interactive jobs
- WAITRCD(0) = fail immediately: flag if no error handler present
- WAITRCD(30) = 30 seconds: recommended safe default

DEADLOCK: Code that acquires locks on multiple files in different orders = MEDIUM: 'Inconsistent lock acquisition order -- potential deadlock. Always lock files in the same sequence.'

FORGOTTEN LOCK: Interactive program (WORKSTN) that reads a record then calls EXFMT holds the lock during entire user interaction. UPDATE after EXFMT = MEDIUM: 'Record lock held during interactive display -- if user abandons session, lock persists.'

CASCADE EFFECT: RGZPFM or CPYF with MBROPT(*REPLACE) on a file during business hours = HIGH: 'File reorganization during business hours causes cascade lock -- all jobs accessing this file will wait.'

OPTIMISTIC LOCKING: Row versioning or timestamp-based conflict detection = POSITIVE pattern, note as good design.

-- SQL INJECTION AND SECURITY PATTERNS --
CRITICAL: SQL injection via string concatenation:
- Building SQL using concatenation with input fields = CRITICAL severity
- Safe pattern: always use parameter markers (:variable) in EXEC SQL
- Never flag EXEC SQL with :variable as injection risk

HARDCODED CREDENTIALS: Passwords, API keys, or connection strings hardcoded in source = HIGH

MISSING SQLCODE CHECK: INSERT/UPDATE/DELETE without checking SQLCODE or SQLSTATE = HIGH if financial data

WHENEVER CLAUSE: EXEC SQL WHENEVER SQLERROR GOTO errorHandler = valid error handling, do NOT flag as missing error handling

-- REST API AND MODERN INTEGRATION PATTERNS --
LOCK AMPLIFICATION: Program holds a file lock and then makes an external call (web service, data queue, socket) while lock is held = MEDIUM: 'Lock held during external call -- network latency extends lock duration'

SERVICE LAYER: RPG service programs (*SRVPGM) encapsulating business logic called by APIs = GOOD architecture. Direct table access from API without service layer = LOW/INFO.

CCSID ENCODING: Programs moving data between IBM i (EBCDIC) and external systems without explicit CCSID handling = LOW: 'Verify character encoding is handled at the API layer'

UNBOUNDED SQL: EXEC SQL SELECT without FETCH FIRST n ROWS ONLY or limiting WHERE clause on large tables = MEDIUM: 'Unbounded result set -- may return millions of rows under production load'

-- AUDIT AND COMPLIANCE PATTERNS --
Financial UPDATE/DELETE with no audit trail = MEDIUM: 'No audit trail -- consider enabling QAUDJRN for this file'
QSYS2.OBJECT_LOCK_INFO: mention in recommendations when lock contention is flagged

── COMMITMENT CONTROL — DEEP KNOWLEDGE ──
THE JOURNALING MISCONCEPTION: Journaling records what happened but does NOT undo previous updates. COMMIT/ROLLBACK is the decision maker. NEVER say journaling provides transactional protection — they are different things. If a program updates multiple files WITHOUT commitment control, each successful update is PERMANENT even if subsequent updates fail. This is silent data corruption — no error, no warning, just partial truth in the data.

COMMITMENT CONTROL SETUP — positive patterns to recognise:
- STRCMTCTL LCKLVL(*CHG) CMTSCOPE(*ACTGRP) in CL = commitment control is active
- COMMIT keyword on file declarations = file is under commitment control
- DFTACTGRP(*NO) ACTGRP('name') in CTL-OPT = correct ILE setup for commitment control
- EXEC SQL SET OPTION COMMIT = *CHG = SQL joins the same transaction as native I/O
- MONITOR/ON-ERROR with ROLLBACK in the ON-ERROR block = production-ready pattern

PITFALL 1 — FORGOTTEN COMMIT: Program writes data under commitment control but no explicit COMMIT before *INLR = *ON. IBM i automatically rolls back uncommitted changes when program ends. Update silently lost, no error. Severity: HIGH.

PITFALL 2 — MIXED COMMITMENT SCOPES: Programs sharing a logical transaction but using different ACTGRP names maintain independent transactions. COMMIT in Program A does NOT commit Program B's changes. Severity: HIGH — partial commits appear to succeed but are incomplete.

PITFALL 3 — LONG-RUNNING TRANSACTION WITH USER INTERACTION: Pattern: COMMIT then CHAIN then UPDATE then EXFMT then COMMIT. Lock is held for the entire EXFMT interaction — could be minutes. Correct: EXFMT should be OUTSIDE the transaction boundary. Severity: MEDIUM.

PITFALL 4 — MISSING ROLLBACK IN ON-ERROR: MONITOR/ON-ERROR that updates multiple files but has no ROLLBACK in the ON-ERROR section. Without ROLLBACK, previous updates in the current transaction remain committed — partial data. Every ON-ERROR in a commitment control context MUST contain ROLLBACK. Severity: HIGH.

BATCH PROCESSING — commit interval: Large batch jobs that UPDATE thousands of records with COMMIT only at end hold locks for hours and block all other access. Correct pattern: COMMIT every 1,000-10,000 records. Detection: batch program with READ loop, multiple UPDATEs, but COMMIT only once at end = MEDIUM.

MIXED NATIVE I/O AND SQL: When program uses both native RPG file I/O and EXEC SQL without EXEC SQL SET OPTION COMMIT = *CHG, both operate in separate transactions — partial commits possible. Severity: HIGH if financial files involved.

ERROR LOG FILE PATTERN (positive): Error logging files deliberately NOT under commitment control = intentional good design. Ensures error records are always written even when transaction rolls back. Recognise and note this as positive.

CPF MESSAGES: CPF8356 (ROLLBACK completed) occurring frequently = application errors in production — each deserves investigation.

── WHAT IS NEVER A RISK ──
Never flag: fixed-format RPG syntax, BEGSR/ENDSR, KLIST/KFLD, numeric indicators used consistently, CHAIN/READE/SETLL/SETGT, Z-ADD/MOVE/MOVEL/MULT/ADD/SUB opcodes, the RPG program cycle, SETON/SETOFF, EXCEPT output, *ENTRY PLIST/PARM, READ/READE with EOF indicator, DFTACTGRP(*YES), century-year logic from 1995-2005.

══════════════════════
SECTION 2 — GRADING RUBRIC
══════════════════════

EXCELLENT — Modern ILE RPG: fully free-format, prototyped procedures, no numeric indicators, named constants, MONITOR/ON-ERROR error handling.
GOOD — Structured ILE RPG: BEGSR/ENDSR, KLIST acceptable, limited numeric indicators used consistently, logical subroutine decomposition.
FAIR — Legacy but maintainable: Fixed-format RPG III/IV, numeric indicators used consistently, standard file I/O patterns. Functional and stable.
POOR — Genuinely risky: GOTO across subroutine boundaries, unguarded division, financial fields with overflow potential, indicators provably reused for conflicting purposes, critical UPDATE with zero error containment at any level.

CRITICAL RATING RULES:
1. POOR requires at least one HIGH finding. Cannot rate POOR with only MEDIUM or below.
2. Number of findings does NOT determine rating. 15 INFO findings = still GOOD or EXCELLENT.
3. Most well-maintained legacy IBM i programs are FAIR. Fixed-format RPG with numeric indicators is FAIR not POOR.
4. When in doubt between two ratings, choose the more positive one.

══════════════════════
SECTION 3 — SEVERITY LEVELS
══════════════════════

CRITICAL — Silent data corruption that continues without job termination: crypto failure with processing continuation, invalid data written to PCI-scoped files.
HIGH — Will cause job crash (MCH1210, MCH1211, CPF5026) or silent financial data corruption with no recovery path.
MEDIUM — Could cause incorrect behaviour under specific but realistic conditions. Needs attention before next release.
LOW — Technical debt, maintainability problem, low-probability edge case.
INFO — Normal for this era or coding style. No action required.

RISK CLASSIFICATION TABLE — include in every Overall Assessment:
| Risk Type | Severity if Present |
|---|---|
| Silent Corruption | CRITICAL |
| Data Divergence (multi-file no commit) | HIGH/MEDIUM |
| Fail-fast / Operational Instability | MEDIUM |
| Compliance / PCI | CRITICAL/HIGH |
| Technical Debt | LOW |
Only include rows where actual findings exist. This table makes the output client-facing and presentation-ready.`;

// ── PLAN LIMITS ───────────────────────────────────────────────────────
const ANALYSIS_LIMITS        = { free: 3,     starter: 25,     team: 150,    admin: 999999 };
const CONVERSION_LIMITS      = { free: 1,     starter: 5,      team: 20,     admin: 999999 };
const CHAR_LIMITS            = { free: 30000, starter: 100000, team: 300000, admin: 999999 };
const CONVERSION_LINE_LIMITS = { free: 500,   starter: 1000,   team: 2000,   admin: 999999 };

const PLAN_NAMES = { free: "Free", starter: "Starter", team: "Team", admin: "Admin" };

const CONV_UPGRADE_HINTS = {
  free:    "Upgrade to Starter (₹2,999/mo) for 5 conversions/month up to 1,000 lines.",
  starter: "Upgrade to Team (₹9,999/mo) for 20 conversions/month up to 2,000 lines.",
  team:    "Contact us for Enterprise with unlimited conversions.",
  admin:   ""
};

const ANALYSIS_UPGRADE_HINTS = {
  free:    "Upgrade to Starter (₹2,999/mo) to analyse programs up to 100,000 characters.",
  starter: "Upgrade to Team (₹9,999/mo) for 150 analyses/month.",
  team:    "Contact us for Enterprise.",
  admin:   ""
};

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "https://rpglens.vercel.app");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")    return res.status(405).json({ error: "Method not allowed" });

  try {
    // ── 1. AUTHENTICATE ───────────────────────────────────────────────
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Not authenticated. Please sign in." });
    }
    const token = authHeader.split(" ")[1];
    const sb    = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    const { data: { user }, error: authError } = await sb.auth.getUser(token);
    if (authError || !user) {
      return res.status(401).json({ error: "Session expired. Please sign in again." });
    }

    // ── 2. ROLLING 30-DAY PERIOD ──────────────────────────────────────
    const plan         = user.user_metadata?.plan || "free";
    const signupDate   = new Date(user.created_at);
    const now          = new Date();
    const daysSince    = Math.floor((now - signupDate) / (1000 * 60 * 60 * 24));
    const periodNumber = Math.floor(daysSince / 30);
    const periodStart  = new Date(signupDate.getTime() + periodNumber * 30 * 24 * 60 * 60 * 1000);
    const periodEnd    = new Date(periodStart.getTime() + 30 * 24 * 60 * 60 * 1000);
    const monthKey     = `period_${periodNumber}`;
    const resetLabel   = periodEnd.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });

    const { prompt, analysisType, codeLength, lineCount } = req.body;
    const isConversion  = analysisType === "convert" || analysisType === "convert_chunk";
    const isFirstChunk  = analysisType === "convert";

    // ── 3. VALIDATE PROMPT ────────────────────────────────────────────
    if (!prompt || typeof prompt !== "string") {
      return res.status(400).json({ error: "No code provided." });
    }
    if (prompt.length > 300000) {
      return res.status(400).json({ error: "Request too large. Maximum 300,000 characters." });
    }

    // ── 4. ENFORCE LIMITS ─────────────────────────────────────────────
    if (isConversion && isFirstChunk && plan !== "admin") {

      // 4a. Line count limit
      const lineLimit = CONVERSION_LINE_LIMITS[plan] || 500;
      const lines     = lineCount || 0;
      if (lines > lineLimit) {
        return res.status(413).json({
          error:     `Program too large for conversion on your ${PLAN_NAMES[plan]} plan. Your program has ${lines.toLocaleString()} lines. ${PLAN_NAMES[plan]} supports up to ${lineLimit.toLocaleString()} lines.`,
          hint:      CONV_UPGRADE_HINTS[plan],
          upgrade:   plan !== "team",
          lineLimit,
          lineCount: lines,
          type:      "line_limit"
        });
      }

      // 4b. Conversion count limit
      const convLimit = CONVERSION_LIMITS[plan] || 1;
      const { data: convData } = await sb
        .from("conversions").select("count")
        .eq("user_id", user.id).eq("month_key", monthKey).single();
      const convCount = convData?.count || 0;

      if (convCount >= convLimit) {
        return res.status(429).json({
          error:     `Conversion limit reached. You have used ${convCount} of ${convLimit} conversions this period. Resets on ${resetLabel}.`,
          hint:      CONV_UPGRADE_HINTS[plan],
          upgrade:   plan !== "team",
          resetDate: periodEnd.toISOString(),
          type:      "conversion_limit"
        });
      }

    } else if (!isConversion && plan !== "admin") {

      // 4c. Character limit
      const charLimit     = CHAR_LIMITS[plan] || 30000;
      const programLength = codeLength || prompt.length;
      if (programLength > charLimit) {
        const kb = Math.round(programLength / 1000);
        return res.status(413).json({
          error:   `Program too large for your ${PLAN_NAMES[plan]} plan (~${kb}KB). ${PLAN_NAMES[plan]} supports up to ${Math.round(charLimit/1000)}KB.`,
          hint:    ANALYSIS_UPGRADE_HINTS[plan],
          upgrade: plan !== "team",
          charLimit,
          programLength
        });
      }

      // 4d. Analysis count limit
      const analysisLimit = ANALYSIS_LIMITS[plan] || 3;
      const { data: usageData } = await sb
        .from("usage").select("count")
        .eq("user_id", user.id).eq("month_key", monthKey).single();
      const usageCount = usageData?.count || 0;

      if (usageCount >= analysisLimit) {
        return res.status(429).json({
          error:     `Monthly limit reached. You have used ${usageCount} of ${analysisLimit} analyses this period. Resets on ${resetLabel}.`,
          hint:      ANALYSIS_UPGRADE_HINTS[plan],
          upgrade:   plan !== "team",
          resetDate: periodEnd.toISOString(),
          type:      "analysis_limit"
        });
      }
    }

    // ── 5. CALL CLAUDE API ────────────────────────────────────────────
    const client    = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const maxTokens = isConversion ? 16000 : 1500;

    // Use system prompt for risk analysis to keep browser payload small
    const isRiskAnalysis = analysisType === "risk";
    const messageParams = {
      model:      "claude-sonnet-4-20250514",
      max_tokens: maxTokens,
      messages:   [{ role: "user", content: prompt }]
    };
    if (isRiskAnalysis) {
      messageParams.system = RISK_SYSTEM_PROMPT;
      messageParams.max_tokens = 4000;
    }
    const message = await client.messages.create(messageParams);

    const result     = message.content.map(b => b.type === "text" ? b.text : "").join("");
    const stopReason = message.stop_reason;

    // ── 6. INCREMENT USAGE ────────────────────────────────────────────
    if (plan !== "admin") {
      if (isFirstChunk) {
        // One conversion credit per full conversion (not per chunk)
        const { data: existing } = await sb
          .from("conversions").select("count")
          .eq("user_id", user.id).eq("month_key", monthKey).single();
        await sb.from("conversions").upsert({
          user_id:    user.id,
          month_key:  monthKey,
          count:      (existing?.count || 0) + 1,
          updated_at: now.toISOString()
        }, { onConflict: "user_id,month_key" });

      } else if (!isConversion) {
        // One analysis credit per API call
        const { data: existing } = await sb
          .from("usage").select("count")
          .eq("user_id", user.id).eq("month_key", monthKey).single();
        await sb.from("usage").upsert({
          user_id:    user.id,
          month_key:  monthKey,
          count:      (existing?.count || 0) + 1,
          updated_at: now.toISOString()
        }, { onConflict: "user_id,month_key" });
      }
    }

    return res.status(200).json({
      result,
      stopReason,
      periodEnd: periodEnd.toISOString(),
      monthKey
    });

  } catch (err) {
    console.error("Proxy error:", err);
    if (err.status === 401) return res.status(502).json({ error: "Analysis service unavailable. Please try again or contact support." });
    if (err.status === 429) return res.status(429).json({ error: "AI service rate limited. Please wait 30 seconds." });
    if (err.status === 529) return res.status(503).json({ error: "AI service overloaded. Please try again." });
    const safe = (err.message||"").includes("fetch") ? "Network error. Please check your connection." : "Analysis failed. Please try again.";
    return res.status(500).json({ error: safe });
  }
}
