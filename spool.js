import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";

// ═══════════════════════════════════════════════════════════════════
// SPOOL FILE ANALYSER — api/spool.js
//
// V2 Priority 2. Supports three input types:
//   - Joblog      (QPJOBLOG)     runtime / escape messages
//   - Compile     (QRPGLESRC listing)  compile errors, RNFxxxx
//   - Dump        (QPPGMDMP)     abend analysis, PSDS / call stack
//
// Paid plans only. Free plan gets ONE lifetime trial, then blocked.
// Admin bypass remains for internal testing.
//
// RLU cost: 1 RLU per 100 lines, same as code analysis.
// ═══════════════════════════════════════════════════════════════════


// ── SPOOL ANALYSER SYSTEM PROMPT ─────────────────────────────────
// Large body — intentionally pushed server-side to keep browser
// payload small, same pattern as RISK_SYSTEM_PROMPT in analyse.js.
const SPOOL_SYSTEM_PROMPT = `You are a senior IBM i production support engineer with 25+ years of experience diagnosing job failures, compile errors, and program abends on IBM i / AS400. You have deep knowledge of DB2 for i, RPG runtime behaviour, the CL command environment, and the full IBM i message queue architecture.

Your job is to read a spool file (joblog, compile listing, or program dump) and tell the user what actually went wrong. Not what the symptoms were — the ROOT CAUSE and the SPECIFIC FIX.

════════════════════════════════════
SECTION 1 — IBM i MESSAGE TAXONOMY
════════════════════════════════════

Every IBM i message has a 4-letter prefix and a 4-digit code. Prefixes tell you where the message came from:

CPF — Control Program Facility (OS-level messages)
MCH — Machine Check (hardware / low-level runtime errors)
RNX — RPG runtime exception (RPG cycle errors, array bounds, divide by zero)
RNF — RPG compile-time (source code problems detected at compile)
SQL — DB2 for i SQL errors (SQL0001-SQL9999)
CPA — Request for reply (inquiry messages — job waiting on operator)
CPD — Diagnostic (informational, does not terminate)
CPI — Informational (completion messages, not errors)
CPC — Completion (successful operation)
TCP — Communications errors

SEVERITY MATTERS. Only ESCAPE messages actually terminate the job.

| Message type | What it means | Job still running? |
|---|---|---|
| *ESCAPE (CPFxxxx) | Unhandled exception — terminates |    NO |
| *STATUS          | Status exception — caller can recover | Depends |
| *NOTIFY          | Notify — caller should take action  | Depends |
| *DIAG            | Diagnostic — FYI only               | YES |
| *INFO            | Informational                       | YES |
| *COMPLETION      | Something finished                  | YES |
| *INQUIRY         | Job is waiting for a reply (G/R/C)  | YES (paused) |

In a joblog of 400 lines, typically 2 or 3 messages matter. The rest are noise. YOUR JOB IS TO SEPARATE THE SIGNAL.

════════════════════════════════════
SECTION 2 — THE CLASSIC FAILURE PATTERNS (JOBLOGS)
════════════════════════════════════

These are the ones you will see over and over in production. Recognise them instantly.

-- CPF5026 — Record locked --
Another job holds a lock on the record the failing job tried to update.
Root cause: concurrent access, often interactive user holding a screen with UPDATE lock.
Fix: WRKOBJLCK OBJ(LIB/FILE) OBJTYPE(*FILE) to identify the holder. For recurring patterns, recommend commitment control + shorter transaction boundaries, or optimistic locking.

-- CPF4131 — Level check --
The compiled program has a different record format than the current file. File was changed but program not recompiled.
Root cause: DDS change without dependent program recompile.
Fix: DSPPGMREF to find dependent programs. Recompile with CRTRPGMOD/CRTBNDRPG. Long term: LVLCHK(*NO) on F-spec only if you're certain format stays stable, otherwise keep LVLCHK(*YES) and recompile properly.

-- CPF4328 — Member not found (often multi-member file) --
Program opened a file where the member name was expected but missing.
Fix: Check OVRDBF in the CL caller. ADDPFM to create the member or fix the override.

-- CPF5029 — Data mapping error --
Data in the record is not valid for the type the program expects. Usually packed decimal corruption.
Fix: DMPOBJ to see record content. Often indicates the file was populated incorrectly — hunt upstream.

-- CPF9999 — Function check --
The catch-all. Something escaped without being handled. Almost always follows an MCH message.
Fix: Scroll UP in the joblog from CPF9999 — the root cause is usually 3-10 messages earlier.

-- MCH1210 — Receiver value too small / decimal data error --
Tried to MOVE non-numeric data into a numeric field, OR tried to fit a larger number into a smaller field.
Fix: Name the target field and the source field. If source is from a file, the DB data is corrupt. If source is a calculation result, the calculation overflowed.

-- MCH1211 — Division by zero --
Classic. Program divided by a field that was zero.
Fix: Add %DIV or EVAL with zero check before the division. The joblog will name the RPG statement number — trace back to the divisor field.

-- MCH3601 — Pointer not set --
Null pointer dereference. Program dereferenced a %ADDR that returned null, OR a parameter pointer was not initialised.
Fix: Check parameter passing in the caller. For ILE service programs, often caused by a procedure called before activation completed.

-- RNX0100 — Array index out of bounds --
Classic OCCURS overflow. Program tried to access element N+1 of an OCCURS(N) DS.
Fix: Increase OCCURS capacity, OR switch to dynamic array with DIM(*AUTO:max). Joblog names the statement — trace the index variable.

-- RNX0112 — Numeric overflow --
Result of arithmetic doesn't fit in the target. Same as MCH1210 at the RPG layer.

-- RNX1201 — Null pointer on dereference --
Same as MCH3601 but raised by RPG runtime.

-- SQL0803 — Duplicate key --
INSERT or UPDATE violated a unique constraint.
Fix: Name the file and the keys. Usually indicates logic error (should have been UPDATE not INSERT) or concurrent insert race condition.

-- SQL0911 — Deadlock or timeout, rollback --
DB2 detected deadlock, rolled back one of the jobs.
Fix: Check job queue for concurrent jobs. Standardise lock acquisition order across programs that update the same files.

-- SQL0913 — Unsuccessful execution due to deadlock --
Like SQL0911 but no rollback — operation just failed.
Fix: Retry logic, or WAITRCD(30) on file declarations.

-- CPF3342 — No job found / CPF1321 — Not authorised to... --
Authority or environment setup error. Often library list issue.
Fix: Check CHGJOB LIBL, ADDLIBLE. Confirm user profile has required authorities with DSPOBJAUT.

════════════════════════════════════
SECTION 3 — COMPILE LISTING PATTERNS
════════════════════════════════════

RNF messages. Severity matters: sev 0-10 is informational, sev 20 is warning, sev 30 is error, sev 40 prevents executable output.

-- RNF5409 — Undefined field --
Field name referenced but not declared. Could be typo, missing /COPY, or field removed from externally described file.
Fix: Name the field. Check D-specs and any /COPY members referenced in H-specs.

-- RNF7030 — Name not defined for the type of reference --
Built-in function called with wrong parameter types or wrong parameter count.
Fix: Name the BIF. Compare against the current ILE RPG reference for correct signature.

-- RNF7471 — Variable not referenced --
Declared but never used. Severity-10 warning, not an error.
Fix: Remove declaration, or (if intentional placeholder) add EVAL xxx = xxx to suppress.

-- RNF7503 — Compile-only variable used in executable statement --
A named constant or D-spec with COMPILE-TIME ONLY was used at runtime.
Fix: Promote to a runtime variable.

-- RNF7066 — Expression contains an operand with type that is not valid --
Type mismatch in an expression. Character field used in numeric context or vice versa.
Fix: Name the line. Add %CHAR(), %INT(), %DEC() conversion BIFs.

-- RNF5358 — Externally described field has a different attribute than program-described --
Program declared a field with one type, but the file says it should be another.
Fix: Let the external description win — remove the D-spec for that field.

THE HIGH-VALUE INSIGHT FOR COMPILE LISTINGS:
The listing shows every diagnostic. But only those with SEVERITY 30+ actually prevented compilation. Report those first, name the line, explain. Then note warnings only if they suggest bigger problems (RNF5358 for instance is only a sev-20 but usually indicates a file/program mismatch that will fail at runtime).

════════════════════════════════════
SECTION 4 — PROGRAM DUMP PATTERNS (QPPGMDMP)
════════════════════════════════════

Program dumps appear when a program abnormally terminates and *PSSR either wasn't defined or issued ENDSR '*CANCL'. The dump is dense but structured.

Key sections to extract:

-- Program name, module, statement number at time of failure --
Usually at the top. The statement number maps to the original RPG source.

-- Message that caused the dump --
The escape message that was unhandled. Start from here.

-- Program Status Data Structure (PSDS) --
If declared, contains:
  *STATUS — 4-digit RPG status code (0100 = array bounds, 1211 = div zero, etc.)
  *ROUTINE — the subroutine that was executing
  *PARMS — the number of parameters passed
  *PROGRAM — the program name
  *PREVIOUS — the previous program in the call stack
Read these BEFORE reading the source. They tell you exactly where the failure happened.

-- Call stack --
The chain of programs that led to the failure. The failing program is at the bottom. Its caller is above. Read bottom-up to understand the call path.

-- File Information Data Structures (INFDS) --
If declared per file, contains the status code of the last operation on that file. Check INFDS for every file referenced near the failure — often tells you which file operation threw the escape message.

-- Field dumps --
Variable values at the moment of termination. Scan for the fields used in the failing operation. NULL pointers, zero divisors, and overflowed numerics are visible here.

THE HIGH-VALUE INSIGHT FOR DUMPS:
A 3,000-line dump has maybe 50 lines that matter. Extract the program name, the statement number, the PSDS *STATUS, the last few lines of the call stack, and the field values involved in the failing statement. Everything else is padding.

════════════════════════════════════
SECTION 5 — THE CROSS-CUTTING PATTERNS
════════════════════════════════════

These appear in all three spool types and are worth calling out.

-- Escape message not handled by *PSSR or MONITOR --
If the failing program had *PSSR, the dump would say "program cancelled by *PSSR". Absence of this phrase means the program had no error handler at the program level. Always flag this in the recommendation.

-- Commitment control state --
If the joblog mentions STRCMTCTL, CMTCTL(*CHG), or ROLLBACK, commitment control was active. If subsequent CPF9999 / CPF8356 appears, ROLLBACK was triggered. Tell the user what was rolled back.

-- Library list surprise --
Many failures trace back to wrong library list. If CPF3142 (File not found) appears, the library list at job start is the first thing to check. The joblog has a section near the top showing DSPJOBLOG/DSPLIBL output if the caller requested it — read that section.

-- Activation group resource leak --
For *CALLER activation groups, resources persist after *INLR. If the joblog shows repeated opens of the same file or mounting memory, the program is running in *CALLER AG when it should be *NEW.

════════════════════════════════════
SECTION 6 — OUTPUT FORMAT (MANDATORY STRUCTURE)
════════════════════════════════════

Use these EXACT section headers. The browser parses these headers and renders each as a distinct card.

## VERDICT
One sentence. Name the exact message code, the program, and the line or statement number. If the spool is a compile listing, name the file and line. If it's a dump, name the program and statement.

Example: "Job terminated with CPF5026 on statement 847 of SAR248 while updating ORDHPF. Record locked by job 123456/JDOE/QPADEV0001."

## ROOT CAUSE
2-3 sentences explaining WHY the failure happened. Not what the symptom was — what caused it. Reference the specific IBM i semantics from Sections 2-4 above.

## MESSAGE TIMELINE
Only escape messages and the 1-2 messages that immediately surround them. Table format:

| Time | Message ID | Type | Summary |
|---|---|---|---|
| 02:14:37 | CPF4131 | *ESCAPE | Level check on file ORDHPF |
| 02:14:37 | CPF9999 | *ESCAPE | Function check in program SAR248 |

If the spool has no timestamps (compile listings, dumps), use statement numbers instead of times.

Do NOT list every diagnostic or informational message. Those are noise.

## TECHNICAL DETAILS
The specifics the user needs to know to act on this. For a joblog: the job name, user, number, library list if relevant, commitment control state, file(s) involved. For a compile: the compiler, source member, option flags. For a dump: the PSDS values, the call stack (bottom 3-5 programs only), and the relevant INFDS status codes.

## RECOMMENDED FIX
Concrete actions. Use the voice of an experienced IBM i developer giving another developer step-by-step guidance. Mix short-term (get the job running again) with long-term (prevent recurrence).

Format as a numbered list.

Example:
1. Immediate: release the lock. Run WRKOBJLCK OBJ(LIBN/ORDHPF) OBJTYPE(*FILE) to identify the holder. If the holder is an abandoned interactive session, ENDJOB it.
2. Re-run the failing job: SBMJOB CMD(CALL PGM(SAR248) PARM('001' 'N')) JOB(SAR248RERUN)
3. Long term: add commitment control to SAR248. Program updates ORDHPF, ORDDPF, INVMPF in sequence — these should be one transaction. STRCMTCTL + COMMIT after the sequence completes, ROLLBACK in MONITOR blocks.
4. Consider migrating to optimistic locking if interactive users edit these records concurrently.

## RELATED FINDINGS
Optional. Only include if you noticed other patterns in the spool worth flagging — for example, a second unrelated error that was masked by the first, or a diagnostic that suggests a bigger architectural issue.

════════════════════════════════════
SECTION 7 — RULES FOR WRITING
════════════════════════════════════

1. NEVER say "an error occurred" or "something went wrong". Always name the specific message code.
2. NEVER guess at statement numbers. If the spool gives you one, use it. If not, say "statement number not visible in spool" and explain how to get it (DSPPGMREF, or compile with listing).
3. NEVER invent job numbers, user profiles, or library names that aren't in the spool.
4. ALWAYS give concrete IBM i commands in the fix — actual CL commands with actual parameters.
5. IF the spool is clearly not a spool file (e.g. user pasted source code by accident), say so and decline politely. Do not try to analyse it anyway.
6. IF the spool is truncated and the critical messages are missing, say so. Point out what's missing and how the user can get the full spool (DSPJOBLOG, CPYSPLF).
7. Keep the TECHNICAL DETAILS section dense with facts, not prose. The reader is an IBM i developer who wants data, not explanation.
8. Write as if the reader is already awake at 2am trying to fix production. Respect their time.`;


// ── PLAN CONFIGURATION ──────────────────────────────────────────
// Spool analyser requires a paid plan. Free plan gets ONE lifetime
// trial, tracked via user_metadata.spool_trial_used.
const SPOOL_RLU_COST_PER_100_LINES = 1;   // Same as analysis

function calcSpoolRLU(lines) {
  const effectiveLines = Math.max(lines || 100, 100);
  return Math.ceil(effectiveLines / 100) * SPOOL_RLU_COST_PER_100_LINES;
}

const SPOOL_UPGRADE_MESSAGE =
  "Spool File Analyser is a paid feature. Upgrade to Starter (₹2,999/mo) for 500 RLUs/month, enough for 50-150 spool analyses depending on size.";


export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "https://rpglens.vercel.app");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")    return res.status(405).json({ error: "Method not allowed" });

  try {
    // ── 1. AUTHENTICATE ─────────────────────────────────────────
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

    // ── 2. VALIDATE REQUEST ─────────────────────────────────────
    const { spoolContent, spoolType, lineCount } = req.body;

    if (!spoolContent || typeof spoolContent !== "string") {
      return res.status(400).json({ error: "No spool content provided." });
    }
    if (spoolContent.length > 300000) {
      return res.status(400).json({
        error: "Spool file too large. Maximum 300,000 characters. For very large joblogs, filter to the failing section with DSPJOBLOG MSGID() or CPYSPLF to a subset.",
        type:  "too_large"
      });
    }

    const validTypes = ["joblog", "compile", "dump", "auto"];
    const typeNormalized = validTypes.includes(spoolType) ? spoolType : "auto";

    // ── 3. PLAN CHECK ── paid feature, free gets ONE lifetime trial ─
    const plan   = user.user_metadata?.plan || "free";
    const isAdmin = plan === "admin";
    const isFree  = plan === "free";

    if (isFree) {
      // Check the user_metadata trial flag. One-shot lifetime trial.
      const trialUsed = user.user_metadata?.spool_trial_used === true;

      if (trialUsed) {
        return res.status(402).json({
          error: "Free trial already used for Spool File Analyser. " + SPOOL_UPGRADE_MESSAGE,
          type:  "spool_trial_exhausted",
          upgrade: true
        });
      }
      // Otherwise, this trial will be marked used after successful processing.
    }

    // ── 4. ENFORCE RLU LIMITS (paid plans only — free trial is "on the house") ─
    const now            = new Date();
    const signupDate     = new Date(user.created_at);
    const daysSince      = Math.floor((now - signupDate) / (1000 * 60 * 60 * 24));
    const periodNumber   = Math.floor(daysSince / 30);
    const periodStart    = new Date(signupDate.getTime() + periodNumber * 30 * 24 * 60 * 60 * 1000);
    const periodEnd      = new Date(periodStart.getTime() + 30 * 24 * 60 * 60 * 1000);
    const monthKey       = `period_${periodNumber}`;

    const effectiveLines = Math.max(lineCount || spoolContent.split("\n").length, 100);
    const rluCost        = calcSpoolRLU(effectiveLines);

    let deductions = null;
    let totalBefore = 0;

    if (!isAdmin && !isFree) {
      // Paid plans: deduct from rlu_credits exactly like /api/analyse does
      const { data: credits } = await sb
        .from("rlu_credits")
        .select("*")
        .eq("user_id", user.id)
        .single();

      if (!credits) {
        return res.status(402).json({
          error: "No RLU balance found. Please contact support.",
          type:  "no_balance"
        });
      }

      // Refresh period if expired
      const periodExpired = credits.period_end && new Date(credits.period_end) < now;
      if (periodExpired) {
        const unusedMonthly  = Math.max(0, credits.monthly_rlu - credits.monthly_used);
        const rolloverAmount = Math.min(
          Math.floor(unusedMonthly * 0.5),
          Math.floor(credits.monthly_rlu * 0.5)
        );
        await sb.from("rlu_credits").update({
          monthly_used:   0,
          rollover_rlu:   (credits.rollover_rlu - credits.rollover_used) + rolloverAmount,
          rollover_used:  0,
          period_key:     monthKey,
          period_start:   periodStart.toISOString(),
          period_end:     periodEnd.toISOString(),
          updated_at:     now.toISOString()
        }).eq("user_id", user.id);
        const { data: refreshed } = await sb.from("rlu_credits").select("*").eq("user_id", user.id).single();
        Object.assign(credits, refreshed);
      }

      const availableMonthly  = credits.monthly_rlu  - credits.monthly_used;
      const availableRollover = credits.rollover_rlu - credits.rollover_used;
      const availableTopup    = credits.topup_rlu    - credits.topup_used;
      totalBefore             = availableMonthly + availableRollover + availableTopup;

      if (totalBefore < rluCost) {
        return res.status(429).json({
          error:    `Insufficient RPGLens Units. This spool analysis requires ${rluCost} RLUs but you have ${totalBefore} remaining.`,
          rluCost,
          available: totalBefore,
          resetDate: periodEnd.toISOString(),
          type:      "rlu_limit",
          upgrade:   plan !== "pro"
        });
      }

      // Deduct monthly → rollover → topup
      let remaining = rluCost;
      deductions = { monthly: 0, rollover: 0, topup: 0 };
      if (remaining > 0 && availableMonthly > 0) {
        deductions.monthly = Math.min(remaining, availableMonthly);
        remaining -= deductions.monthly;
      }
      if (remaining > 0 && availableRollover > 0) {
        deductions.rollover = Math.min(remaining, availableRollover);
        remaining -= deductions.rollover;
      }
      if (remaining > 0 && availableTopup > 0) {
        deductions.topup = Math.min(remaining, availableTopup);
        remaining -= deductions.topup;
      }

      await sb.from("rlu_credits").update({
        monthly_used:       credits.monthly_used  + deductions.monthly,
        rollover_used:      credits.rollover_used + deductions.rollover,
        topup_used:         credits.topup_used    + deductions.topup,
        total_rlu_consumed: credits.total_rlu_consumed + rluCost,
        total_analyses:     credits.total_analyses + 1,
        updated_at:         now.toISOString()
      }).eq("user_id", user.id);

      await sb.from("rlu_transactions").insert({
        user_id:       user.id,
        action:        "spool",
        tab:           typeNormalized,
        lines:         effectiveLines,
        rlu_cost:      rluCost,
        rlu_source:    deductions.monthly > 0 ? "monthly" : deductions.rollover > 0 ? "rollover" : "topup",
        balance_after: totalBefore - rluCost,
        program_name:  spoolContent.slice(0, 50).replace(/\n/g, " ")
      });
    }

    // ── 5. CALL CLAUDE ──────────────────────────────────────────
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const userPrompt = `The user has uploaded a spool file${typeNormalized !== "auto" ? ` (declared type: ${typeNormalized})` : ""}. Analyse it according to Section 6 output format.

\`\`\`
${spoolContent}
\`\`\``;

    const message = await client.messages.create({
      model:      "claude-sonnet-4-20250514",
      max_tokens: 4500,
      system:     SPOOL_SYSTEM_PROMPT,
      messages:   [{ role: "user", content: userPrompt }]
    });

    const result     = message.content.map(b => b.type === "text" ? b.text : "").join("");
    const stopReason = message.stop_reason;

    // ── 6. MARK FREE TRIAL AS USED (only after successful analysis) ─
    if (isFree) {
      try {
        await sb.auth.admin.updateUserById(user.id, {
          user_metadata: {
            ...(user.user_metadata || {}),
            spool_trial_used:    true,
            spool_trial_used_at: now.toISOString()
          }
        });
      } catch (mdErr) {
        // Don't fail the request if metadata update fails — log and continue
        console.warn("spool_trial_used metadata update failed:", mdErr && mdErr.message);
      }
    }

    // ── 7. FETCH UPDATED BALANCE ────────────────────────────────
    let rluBalance = null;
    if (!isAdmin && !isFree) {
      const { data: updated } = await sb
        .from("rlu_credits")
        .select("monthly_rlu,monthly_used,rollover_rlu,rollover_used,topup_rlu,topup_used")
        .eq("user_id", user.id)
        .single();
      if (updated) {
        rluBalance = {
          monthly:  updated.monthly_rlu  - updated.monthly_used,
          rollover: updated.rollover_rlu - updated.rollover_used,
          topup:    updated.topup_rlu    - updated.topup_used,
          total:    (updated.monthly_rlu  - updated.monthly_used) +
                    (updated.rollover_rlu - updated.rollover_used) +
                    (updated.topup_rlu    - updated.topup_used)
        };
      }
    }

    return res.status(200).json({
      result,
      stopReason,
      spoolType: typeNormalized,
      lineCount: effectiveLines,
      rluCost:   isFree ? 0 : rluCost,
      rluBalance,
      trialUsed: isFree,
      periodEnd: periodEnd.toISOString()
    });

  } catch (err) {
    console.error("Spool analyser error:", err);
    if (err.status === 401) return res.status(502).json({ error: "Spool analysis service unavailable. Please try again or contact support." });
    if (err.status === 429) return res.status(429).json({ error: "AI service rate limited. Please wait 30 seconds." });
    if (err.status === 529) return res.status(503).json({ error: "AI service overloaded. Please try again." });
    const safe = (err.message || "").includes("fetch") ? "Network error. Please check your connection." : "Spool analysis failed. Please try again.";
    return res.status(500).json({ error: safe });
  }
}
