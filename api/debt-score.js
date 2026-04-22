// debt-score.js
//
// Modernisation Debt Score — RPGLens V2 Priority 1
// ------------------------------------------------
// Computes a 0-100 numeric debt score for a single RPG program
// from the Pass 1 JSON summary produced by /api/analyse.js
// (when analysisType === 'summary').
//
// Maps the numeric score to the four-level DEBT_LEVEL scale
// defined in "IBM i Modernization Playbook" Chapter 6 / Chapter 33:
//   LOW | MEDIUM | HIGH | CRITICAL
//
// This keeps the single-program score consistent with the
// AI_PROGRAM_DOCS schema in Ch 33 and with the Modernization Debt
// Radar (Dimension 1) in Ch 6.
//
// Pure function. No side effects. No network calls. No IO. No RLU cost.
// Runs in the browser, called from analyser.html after Pass 1 parses
// the summary JSON.
//
// Author: Y B Audi
// Named concept source: Modernization Debt (Ch 2, Ch 6, Ch 33)

(function (root) {
  'use strict';

  // ---------------------------------------------------------------
  // Weights — total = 100. Tune in one place.
  // ---------------------------------------------------------------
  var WEIGHTS = {
    format:             15,
    error_handling:     15,
    commitment_control: 15,
    indicators:         10,
    hardcoded:          10,
    size:               10,
    modularity:         10,
    occurs:              8,
    lda:                 7
  };

  // ---------------------------------------------------------------
  // Level thresholds — matches book's four-level scale (Ch 6)
  //
  // Colours chosen to match RPGLens' analyser palette:
  //   LOW      → green   (var(--green)   #2ec27e)
  //   MEDIUM   → amber   (var(--amber)   #e8a020)
  //   HIGH     → orange  (kept distinct from amber for clarity)
  //   CRITICAL → red     (var(--red)     #e85050)
  // ---------------------------------------------------------------
  var LEVELS = [
    { max: 24,  level: 'LOW',      color: '#2ec27e', band: 'Isolated issues. Safe to proceed with normal maintenance.' },
    { max: 49,  level: 'MEDIUM',   color: '#e8a020', band: 'Localised debt. Addressable within a single phase with planned mitigation.' },
    { max: 74,  level: 'HIGH',     color: '#d97438', band: 'Program-wide debt. Affects modernisation sequencing and timeline.' },
    { max: 100, level: 'CRITICAL', color: '#e85050', band: 'Blocks modernisation on the current path. Address before any API or refactor work.' }
  ];

  var DIMENSION_LABELS = {
    format:             'Format',
    error_handling:     'Error Handling',
    commitment_control: 'Commitment Control',
    indicators:         'Indicator Usage',
    hardcoded:          'Hardcoded Values',
    size:               'Program Size',
    modularity:         'Modularity',
    occurs:             'OCCURS Overflow Risk',
    lda:                'LDA Dependency'
  };

  function classify(score) {
    for (var i = 0; i < LEVELS.length; i++) {
      if (score <= LEVELS[i].max) return LEVELS[i];
    }
    return LEVELS[LEVELS.length - 1];
  }

  function arr(v) { return Array.isArray(v) ? v : (v == null ? [] : [v]); }
  function str(v) { return (v == null ? '' : String(v)).toLowerCase(); }

  // ---------------------------------------------------------------
  // Dimension scorers — each reads structured fields from the summary.
  // No free-text regex. No negation handling needed. Booleans decide.
  // ---------------------------------------------------------------

  // 1. FORMAT — fixed-format carries the most debt, mixed less, free none.
  //    Small utility programs get a reduced penalty since fixed-format
  //    is acceptable for a 40-line helper.
  function scoreFormat(s, lines) {
    var max = WEIGHTS.format;
    var fmt = str(s.format);
    var smallMult = (lines > 0 && lines < 150) ? 0.25 : 1.0;

    if (fmt === 'free') {
      return { points: 0, max: max, note: 'Fully free-format RPG. No format debt.' };
    }
    if (fmt === 'mixed') {
      return {
        points: Math.round(max * 0.55 * smallMult), max: max,
        note: 'Mixed fixed and /FREE blocks. Partial conversion debt.' +
              (smallMult < 1 ? ' Reduced penalty for small program.' : '')
      };
    }
    // Treat unknown or 'fixed' as fixed-format debt
    return {
      points: Math.round(max * smallMult), max: max,
      note: 'Fixed-format RPG.' +
            (smallMult < 1 ? ' Reduced penalty for small program.' : ' Full format modernisation required.')
    };
  }

  // 2. ERROR HANDLING — driven by patterns.has_monitor_on_error and
  //    patterns.has_pssr. Modern ILE programs use MONITOR/ON-ERROR
  //    plus INFDS. *PSSR alone is a legacy catch-all.
  function scoreErrorHandling(s, lines) {
    var max = WEIGHTS.error_handling;
    var p = s.patterns || {};
    var sizeMult = (lines > 0 && lines < 150) ? 0.25 : 1.0;

    var hasMonitor = !!p.has_monitor_on_error;
    var hasPssr    = !!p.has_pssr;

    if (!hasMonitor && !hasPssr) {
      return {
        points: Math.round(max * sizeMult), max: max,
        note: 'No error handling detected — neither MONITOR/ON-ERROR nor *PSSR present.' +
              (sizeMult < 1 ? ' Reduced penalty for small program.' : ' Unhandled exceptions terminate the job.')
      };
    }
    if (hasMonitor) {
      return {
        points: Math.round(max * 0.20 * sizeMult), max: max,
        note: 'MONITOR / ON-ERROR present. Modern ILE error handling in place.'
      };
    }
    // *PSSR only
    return {
      points: Math.round(max * 0.65 * sizeMult), max: max,
      note: '*PSSR defined but no MONITOR / ON-ERROR. Catch-all error subroutine without per-procedure coverage.'
    };
  }

  // 3. COMMITMENT CONTROL — the summary exposes three relevant flags:
  //    has_commit_keyword, multi_file_update_no_commit, batch_loop_no_commit.
  //    Also consider update_after_exfmt as a lock-management concern.
  function scoreCommitmentControl(s) {
    var max = WEIGHTS.commitment_control;
    var p = s.patterns || {};
    var files = arr(s.files);

    // Count updateable files to distinguish single-file from multi-file scope
    var updateFiles = 0;
    for (var i = 0; i < files.length; i++) {
      var access = str(files[i] && files[i].access);
      if (/update|output/.test(access)) updateFiles++;
    }

    var hasCommit = !!p.has_commit_keyword;

    // The summary explicitly flags the worst case
    if (p.multi_file_update_no_commit === true) {
      return {
        points: max, max: max,
        note: updateFiles + ' updateable files without commitment control. Silent partial-update corruption risk.'
      };
    }

    if (p.batch_loop_no_commit === true) {
      return {
        points: Math.round(max * 0.75), max: max,
        note: 'Batch loop without periodic COMMIT. Long-running transactions hold locks and risk data divergence on failure.'
      };
    }

    if (hasCommit) {
      // Commitment control declared and no red flags raised
      if (p.update_after_exfmt === true) {
        return {
          points: Math.round(max * 0.35), max: max,
          note: 'COMMIT keyword present but UPDATE follows EXFMT. Lock held during user interaction — interactive lock management concern.'
        };
      }
      return { points: 0, max: max, note: 'Commitment control active. COMMIT keyword present on file declarations.' };
    }

    // No commit keyword, but only one or zero updateable files — minor debt
    if (updateFiles <= 1) {
      return {
        points: Math.round(max * 0.20), max: max,
        note: updateFiles === 0
          ? 'No updateable files. Commitment control not applicable.'
          : 'Single updateable file. Commitment control optional.'
      };
    }

    // Multiple updateable files but neither flag specifically raised
    return {
      points: Math.round(max * 0.60), max: max,
      note: updateFiles + ' updateable files with no COMMIT keyword. Transaction boundary unclear.'
    };
  }

  // 4. INDICATOR USAGE — count distinct *IN## references in key_variables.
  //    The summary's key_variables is a structured list of { name, type, purpose }.
  function scoreIndicators(s) {
    var max = WEIGHTS.indicators;
    var kv = arr(s.key_variables);
    var seen = {};
    var count = 0;
    for (var i = 0; i < kv.length; i++) {
      var n = str(kv[i] && kv[i].name);
      var m = n.match(/\*in\d{2}/);
      if (m && !seen[m[0]]) { seen[m[0]] = true; count++; }
    }

    if (count === 0) return { points: 0, max: max, note: 'No numbered indicators in key variables. Named flags in use.' };
    if (count >= 8)  return { points: max, max: max, note: 'Heavy numbered indicator usage (' + count + ' distinct *IN## references). Control flow opaque.' };
    if (count >= 4)  return { points: Math.round(max * 0.70), max: max, note: count + ' distinct numbered indicators in use.' };
    return { points: Math.round(max * 0.35), max: max, note: count + ' numbered indicator(s) present. Consider renaming to BOOLEAN fields.' };
  }

  // 5. HARDCODED VALUES — pulled from patterns.hardcoded_values (array).
  //    Filter out the placeholder string from the prompt template.
  function scoreHardcoded(s) {
    var max = WEIGHTS.hardcoded;
    var hv = arr(s.patterns && s.patterns.hardcoded_values).filter(function (v) {
      if (!v) return false;
      var t = str(v);
      // Filter placeholder text from the prompt template itself
      return t.length > 0 && t !== 'list key hardcoded values found';
    });
    var n = hv.length;

    if (n === 0)  return { points: 0,                      max: max, note: 'No hardcoded values detected in summary.' };
    if (n <= 2)   return { points: Math.round(max * 0.25), max: max, note: n + ' hardcoded value(s). Minor debt.' };
    if (n <= 5)   return { points: Math.round(max * 0.55), max: max, note: n + ' hardcoded values. Promote to named constants or a configuration data area.' };
    if (n <= 10)  return { points: Math.round(max * 0.80), max: max, note: n + ' hardcoded values. Multiple literals embedded in business logic.' };
    return              { points: max,                     max: max, note: n + ' hardcoded values. Extensive embedded literals — high risk when business rules change.' };
  }

  // 6. PROGRAM SIZE — from summary.estimated_lines.
  function scoreSize(s) {
    var max = WEIGHTS.size;
    var lines = parseInt(s.estimated_lines, 10) || 0;

    if (!lines)       return { points: Math.round(max * 0.30), max: max, note: 'Line count not provided. Assuming moderate size.' };
    if (lines < 200)  return { points: 0,                      max: max, note: lines + ' lines. Small program.' };
    if (lines < 500)  return { points: Math.round(max * 0.25), max: max, note: lines + ' lines. Medium program.' };
    if (lines < 1000) return { points: Math.round(max * 0.50), max: max, note: lines + ' lines. Large program — refactoring into service programs recommended.' };
    if (lines < 2500) return { points: Math.round(max * 0.75), max: max, note: lines + ' lines. Monolithic program.' };
    return                   { points: max,                    max: max, note: lines + ' lines. Exceptional size. Full ILE refactor is a multi-week effort (Ch 33).' };
  }

  // 7. MODULARITY — based on subroutine count and avg size.
  //    Small programs are not penalised for lack of modularity.
  function scoreModularity(s) {
    var max = WEIGHTS.modularity;
    var subs = arr(s.subroutines);
    var n = subs.length;
    var lines = parseInt(s.estimated_lines, 10) || 0;

    if (lines > 0 && lines < 300) {
      return { points: 0, max: max, note: 'Small program. Modularity not material.' };
    }
    if (n === 0 && lines >= 300) {
      return {
        points: max, max: max,
        note: 'No subroutines declared in a ' + lines + '-line program. Monolithic / linear structure.'
      };
    }
    if (n === 0) return { points: Math.round(max * 0.50), max: max, note: 'Subroutine count unknown or zero.' };

    var avg = lines > 0 ? Math.round(lines / n) : 0;
    if (avg > 300) return { points: Math.round(max * 0.85), max: max, note: n + ' subroutines averaging ~' + avg + ' lines each. Long subroutines — candidates for extraction to procedures.' };
    if (avg > 150) return { points: Math.round(max * 0.60), max: max, note: n + ' subroutines averaging ~' + avg + ' lines each. Moderate modularity.' };
    if (n >= 5)    return { points: Math.round(max * 0.25), max: max, note: n + ' subroutines, reasonable decomposition. Minor debt from BEGSR/ENDSR vs ILE procedures.' };
    return               { points: Math.round(max * 0.40), max: max, note: n + ' subroutine(s). Limited decomposition.' };
  }

  // 8. OCCURS OVERFLOW RISK — summary provides occurs_ds[] with numeric capacity.
  function scoreOccurs(s) {
    var max = WEIGHTS.occurs;
    var occ = arr(s.occurs_ds);
    if (occ.length === 0) return { points: 0, max: max, note: 'No OCCURS data structures.' };

    var risky = 0;
    for (var i = 0; i < occ.length; i++) {
      var cap = parseInt(occ[i] && occ[i].capacity, 10) || 0;
      // Fixed capacities up to 999 raise RNX0100 risk if volume grows
      if (cap > 0 && cap <= 999) risky++;
    }
    if (risky >= 2) return { points: max,                    max: max, note: occ.length + ' OCCURS data structures, ' + risky + ' with fixed capacity ≤ 999 — RNX0100 overflow risk if volume grows.' };
    if (risky === 1) return { points: Math.round(max * 0.65), max: max, note: occ.length + ' OCCURS data structure(s), one with fixed-capacity overflow risk.' };
    return                   { points: Math.round(max * 0.35), max: max, note: occ.length + ' OCCURS data structure(s). Review capacity sizing.' };
  }

  // 9. LDA DEPENDENCY — driven by patterns.has_lda and data_areas list.
  function scoreLda(s) {
    var max = WEIGHTS.lda;
    var p = s.patterns || {};
    var dataAreas = arr(s.data_areas).filter(function (d) { return d && d.name; });

    var usesLda = !!p.has_lda;
    var otherDta = false;
    for (var i = 0; i < dataAreas.length; i++) {
      var nm = str(dataAreas[i].name);
      if (nm && !/\*lda|^lda$/.test(nm)) { otherDta = true; break; }
    }

    if (usesLda && otherDta) return { points: max,                    max: max, note: 'LDA plus other data area dependencies. Job-scoped state — does not exist outside the 5250 session.' };
    if (usesLda)             return { points: Math.round(max * 0.80), max: max, note: 'LDA dependency detected. Job-scoped state must be replicated at wrapper boundary for API exposure.' };
    if (otherDta)            return { points: Math.round(max * 0.55), max: max, note: 'Data area dependency (not LDA). State management at wrapper boundary required.' };
    return                          { points: 0,                      max: max, note: 'No LDA or data area dependency detected.' };
  }

  // ---------------------------------------------------------------
  // Main entry point
  // ---------------------------------------------------------------
  function computeDebtScore(summary) {
    if (!summary || typeof summary !== 'object') {
      return {
        score: 0,
        level: 'UNKNOWN',
        color: '#5a5855',
        band:  'Summary unavailable. Debt score cannot be computed.',
        components: {},
        headline: 'Modernisation Debt Score unavailable — no structural summary produced.',
        generated_at: new Date().toISOString()
      };
    }

    var lines = parseInt(summary.estimated_lines, 10) || 0;

    var components = {
      format:             scoreFormat(summary, lines),
      error_handling:     scoreErrorHandling(summary, lines),
      commitment_control: scoreCommitmentControl(summary),
      indicators:         scoreIndicators(summary),
      hardcoded:          scoreHardcoded(summary),
      size:               scoreSize(summary),
      modularity:         scoreModularity(summary),
      occurs:             scoreOccurs(summary),
      lda:                scoreLda(summary)
    };

    var total = 0;
    Object.keys(components).forEach(function (k) { total += components[k].points; });
    total = Math.max(0, Math.min(100, Math.round(total)));

    var cls = classify(total);

    // Build the top 3 dimensions by debt ratio for the headline
    var ranked = Object.keys(components).map(function (k) {
      var c = components[k];
      return { key: k, ratio: c.max ? c.points / c.max : 0 };
    }).filter(function (x) { return x.ratio > 0.5; })
      .sort(function (a, b) { return b.ratio - a.ratio; })
      .slice(0, 3)
      .map(function (x) { return DIMENSION_LABELS[x.key]; });

    var headline;
    if (total === 0) {
      headline = 'No material modernisation debt detected. Program is well-structured for its era.';
    } else if (ranked.length === 0) {
      headline = 'Debt is distributed across several dimensions with no single dominant factor.';
    } else {
      headline = 'Primary debt concentration: ' + ranked.join(', ') + '.';
    }

    return {
      score:        total,
      level:        cls.level,
      color:        cls.color,
      band:         cls.band,
      components:   components,
      headline:     headline,
      generated_at: new Date().toISOString()
    };
  }

  // Expose to window. Browser-only — no CommonJS.
  root.RPGLensDebtScore = {
    compute:    computeDebtScore,
    WEIGHTS:    WEIGHTS,
    LEVELS:     LEVELS,
    LABELS:     DIMENSION_LABELS
  };

})(typeof window !== 'undefined' ? window : this);
