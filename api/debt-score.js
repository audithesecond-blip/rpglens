// api/debt-score.js
//
// Modernisation Debt Score — RPGLens V2 Priority 1
// ------------------------------------------------
// Computes a 0-100 numeric debt score for a single RPG program
// from the Pass 1 JSON summary produced by analyse.js.
//
// Maps the numeric score to the four-level DEBT_LEVEL scale
// defined in "IBM i Modernization Playbook" Chapter 6 / Chapter 33:
//   LOW | MEDIUM | HIGH | CRITICAL
//
// This keeps the single-program score consistent with the
// AI_PROGRAM_DOCS schema in Ch 33 and with the Modernization Debt
// Radar (Dimension 1) in Ch 6.
//
// Pure function. No side effects. No network calls. No IO.
// Safe to call from anywhere in the analysis pipeline.
//
// Author: Y B Audi
// Named concept source: Modernization Debt (Ch 2, Ch 6, Ch 33)

'use strict';

// ---------------------------------------------------------------
// Weights — total = 100. Tune these in one place.
// ---------------------------------------------------------------
const WEIGHTS = {
  format:             15,
  error_handling:     15,
  commitment_control: 15,
  indicators:         10,
  hardcoded:          10,
  size:               10,
  modularity:         10,
  occurs:              8,
  lda:                 7,
};

// ---------------------------------------------------------------
// Level thresholds — matches book's four-level scale
// ---------------------------------------------------------------
const LEVELS = [
  { max: 24,  level: 'LOW',      color: '#15803d', band: 'Isolated issues. Safe to proceed with normal maintenance.' },
  { max: 49,  level: 'MEDIUM',   color: '#b45309', band: 'Localised debt. Addressable within a single phase with planned mitigation.' },
  { max: 74,  level: 'HIGH',     color: '#c2410c', band: 'Program-wide debt. Affects modernisation sequencing and timeline.' },
  { max: 100, level: 'CRITICAL', color: '#991b1b', band: 'Blocks modernisation on the current path. Address before any API or refactor work.' },
];

function classify(score) {
  for (const l of LEVELS) if (score <= l.max) return l;
  return LEVELS[LEVELS.length - 1];
}

// ---------------------------------------------------------------
// Utility — pull a string from an unknown-shape summary field
// ---------------------------------------------------------------
function asText(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v.toLowerCase();
  if (typeof v === 'object') {
    try { return JSON.stringify(v).toLowerCase(); } catch { return ''; }
  }
  return String(v).toLowerCase();
}

function asArray(v) {
  if (Array.isArray(v)) return v;
  if (v == null) return [];
  return [v];
}

// ---------------------------------------------------------------
// Individual dimension scorers
// Each returns { points, max, note } where points <= max.
// ---------------------------------------------------------------

// 1. FORMAT — fixed-format carries more debt than free-format.
function scoreFormat(summary, sourceCodeMeta) {
  const fmt = asText(summary.format);
  const max = WEIGHTS.format;
  const lines = (sourceCodeMeta && sourceCodeMeta.lineCount) || summary.line_count || 0;

  // Small utility programs — fixed-format is acceptable; reduce penalty
  const smallMult = (lines > 0 && lines < 150) ? 0.25 : 1.0;

  // Free-format
  if (/\bfree\b/.test(fmt) && !/mixed|fixed|hybrid/.test(fmt)) {
    return { points: 0, max, note: 'Fully free-format RPG. No format debt.' };
  }
  // Mixed / hybrid — /FREE blocks inside fixed-format source
  if (/mixed|hybrid|partial/.test(fmt) || (/free/.test(fmt) && /fixed/.test(fmt))) {
    return { points: Math.round(max * 0.55 * smallMult), max, note: 'Mixed fixed and /FREE blocks. Partial conversion debt.' + (smallMult < 1 ? ' Reduced penalty for small program.' : '') };
  }
  // Fixed-format (default when we cannot determine otherwise on a legacy program)
  if (/fixed/.test(fmt) || fmt === '') {
    return { points: Math.round(max * smallMult), max, note: 'Fixed-format RPG.' + (smallMult < 1 ? ' Reduced penalty for small program.' : ' Full format modernisation required.') };
  }
  // Unknown / fully-free
  return { points: 0, max, note: 'Format: ' + (summary.format || 'unspecified') + '. No debt assigned.' };
}

// Detect whether a feature is PRESENT in text, honouring explicit negation.
// Example: text "No MONITOR. No *PSSR." should NOT count MONITOR as present.
//
// featurePattern — regex that matches the feature being detected
// featureAlt     — string alternation (no parens) of the feature's lexical forms,
//                  e.g. 'monitor|on-?error'. Wrapped in a non-capturing group
//                  internally so the negation clause binds correctly.
function hasPresent(text, featurePattern, featureAlt) {
  if (featureAlt) {
    const negRegex = new RegExp(
      '(?:\\bno\\b|\\bwithout\\b|\\bnot\\b|\\bmissing\\b|\\blacks?\\b|\\babsent\\b|\\bzero\\b|\\bnever\\b)' +
      '[^.]{0,40}' +
      '(?:' + featureAlt + ')',
      'i'
    );
    if (negRegex.test(text)) return false;
  }
  return featurePattern.test(text);
}

// 2. ERROR HANDLING — *PSSR only / INFDS absent / no MONITOR = high debt.
function scoreErrorHandling(summary, sourceCodeMeta) {
  const max   = WEIGHTS.error_handling;
  const lines = (sourceCodeMeta && sourceCodeMeta.lineCount) || summary.line_count || 0;
  const p     = asText(summary.patterns);
  const full  = p + ' ' + asText(summary.ghost_business_rules);

  const hasMonitor = hasPresent(full, /\bmonitor\b|on-error|on_error|on_err/, 'monitor|on-?error|on_error|on_err');
  const hasPssr    = hasPresent(full, /\*pssr|\bpssr\b/,                       '\\*?pssr');
  const hasInfds   = hasPresent(full, /\binfds\b|\binfsr\b/,                   'infds|infsr');
  const noneFound  = !hasMonitor && !hasPssr && !hasInfds;

  // Small programs — lack of formal error handling is less material
  const sizeMultiplier = (lines > 0 && lines < 150) ? 0.25 : 1.0;

  if (noneFound) {
    return { points: Math.round(max * sizeMultiplier),           max, note: 'No error handling detected (*PSSR, MONITOR, INFDS all absent).' + (sizeMultiplier < 1 ? ' Reduced penalty for small program.' : ' Unhandled exceptions terminate with RNQ/CPF halt.') };
  }
  if (hasMonitor && hasInfds) {
    return { points: 0, max, note: 'MONITOR / ON-ERROR plus INFDS present. Modern ILE error handling in place.' };
  }
  if (hasMonitor) {
    return { points: Math.round(max * 0.25 * sizeMultiplier), max, note: 'MONITOR / ON-ERROR present but INFDS not referenced. Partial coverage.' };
  }
  if (hasPssr && !hasMonitor) {
    return { points: Math.round(max * 0.70 * sizeMultiplier), max, note: '*PSSR only. Catch-all error subroutine without per-procedure MONITOR.' };
  }
  return { points: Math.round(max * 0.50 * sizeMultiplier), max, note: 'Partial error handling. Review for gaps.' };
}

// 3. COMMITMENT CONTROL — multi-file updates without COMMIT/ROLLBACK = high debt.
function scoreCommitmentControl(summary) {
  const max   = WEIGHTS.commitment_control;
  const p     = asText(summary.patterns);
  const files = asArray(summary.files);

  // Count files flagged as update / output
  const updateFiles = files.filter(f => {
    const u = asText(f && (f.usage || f.mode || f.access || f));
    return /update|output|write|add|delete|u\b|o\b/.test(u);
  }).length;

  const hasCommit     = hasPresent(p, /\bcommit\b|\bcommitment\b/, 'commit|commitment');
  const hasRollback   = hasPresent(p, /\brollback\b|\brolbk\b/,    'rollback|rolbk');
  const hasJournaling = hasPresent(p, /journal/,                    'journal');

  // Single-file programs — commitment control rarely applies
  if (updateFiles <= 1) {
    if (hasCommit && hasRollback) {
      return { points: 0, max, note: 'Single-file update scope with COMMIT/ROLLBACK present.' };
    }
    return { points: Math.round(max * 0.20), max, note: 'Single updateable file. Commitment control optional; minor debt.' };
  }

  // Multi-file updates
  if (hasCommit && hasRollback) {
    return { points: 0, max, note: 'Multi-file update scope with COMMIT and ROLLBACK both present.' };
  }
  if (hasCommit || hasRollback) {
    return { points: Math.round(max * 0.55), max, note: 'Partial commitment control. COMMIT or ROLLBACK present but not both. Transaction boundary unclear.' };
  }
  if (hasJournaling) {
    return { points: Math.round(max * 0.80), max, note: 'Journaling referenced but no COMMIT/ROLLBACK in source. Journaling alone does not provide transactional protection.' };
  }
  return { points: max, max, note: updateFiles + ' updateable files with no COMMIT/ROLLBACK. Silent partial-update corruption risk.' };
}

// 4. INDICATOR USAGE — numbered indicators carry debt.
function scoreIndicators(summary) {
  const max = WEIGHTS.indicators;
  const p   = asText(summary.patterns);
  const kv  = asText(summary.key_variables);
  const blob = p + ' ' + kv;

  // Count distinct numbered indicator references like *IN01, *IN99, *IN35
  const matches = blob.match(/\*in\d{2}/g) || [];
  const unique  = new Set(matches);
  const count   = unique.size;

  // Heuristic — also flag if the summary text mentions them qualitatively
  const mentionsHeavy  = /heavy.*indicator|many.*indicator|indicator.{0,15}(heavy|extensive|many|numerous)/.test(blob);
  const mentionsLight  = /named.*indicator|no numbered indicator|indicator-free|free of indicators/.test(blob);

  if (mentionsLight && count === 0) {
    return { points: 0, max, note: 'No numbered indicators detected. Named BOOLEAN flags in use.' };
  }
  if (count >= 8 || mentionsHeavy) {
    return { points: max, max, note: 'Heavy numbered indicator usage (' + (count || 'multiple') + ' distinct). Control flow opaque.' };
  }
  if (count >= 4) {
    return { points: Math.round(max * 0.70), max, note: count + ' distinct numbered indicators in use.' };
  }
  if (count >= 1) {
    return { points: Math.round(max * 0.35), max, note: count + ' numbered indicator(s) present. Consider renaming to BOOLEAN fields.' };
  }
  return { points: 0, max, note: 'No numbered indicators detected.' };
}

// 5. HARDCODED VALUES — literals embedded in logic.
function scoreHardcoded(summary) {
  const max = WEIGHTS.hardcoded;
  const hv  = asArray(summary.hardcoded_values);
  const n   = hv.length;

  if (n === 0) return { points: 0,                     max, note: 'No hardcoded values detected in summary.' };
  if (n <= 2)  return { points: Math.round(max * 0.25), max, note: n + ' hardcoded value(s). Minor debt.' };
  if (n <= 5)  return { points: Math.round(max * 0.55), max, note: n + ' hardcoded values. Promote to named constants or a configuration data area.' };
  if (n <= 10) return { points: Math.round(max * 0.80), max, note: n + ' hardcoded values. Multiple magic numbers or literals embedded in business logic.' };
  return       { points: max,                            max, note: n + ' hardcoded values. Extensive embedded literals — high risk when business rules change.' };
}

// 6. PROGRAM SIZE — larger programs carry more latent debt.
function scoreSize(summary, sourceCodeMeta) {
  const max = WEIGHTS.size;
  const lines = (sourceCodeMeta && sourceCodeMeta.lineCount) || summary.line_count || 0;

  if (!lines)           return { points: Math.round(max * 0.30), max, note: 'Line count not provided. Assuming moderate size.' };
  if (lines < 200)      return { points: 0,                      max, note: lines + ' lines. Small program.' };
  if (lines < 500)      return { points: Math.round(max * 0.25), max, note: lines + ' lines. Medium program.' };
  if (lines < 1000)     return { points: Math.round(max * 0.50), max, note: lines + ' lines. Large program — refactoring into service programs recommended.' };
  if (lines < 2500)     return { points: Math.round(max * 0.75), max, note: lines + ' lines. Monolithic program.' };
  return                       { points: max,                    max, note: lines + ' lines. Exceptional size. Full ILE refactor is a multi-week effort (Ch 33).' };
}

// 7. MODULARITY — subroutine count and size distribution.
// Lack of subroutines in a large program, or a single massive subroutine, = debt.
function scoreModularity(summary, sourceCodeMeta) {
  const max   = WEIGHTS.modularity;
  const subs  = asArray(summary.subroutines);
  const n     = subs.length;
  const lines = (sourceCodeMeta && sourceCodeMeta.lineCount) || summary.line_count || 0;

  // If program is small, modularity matters less
  if (lines && lines < 300) {
    return { points: 0, max, note: 'Small program. Modularity not material.' };
  }

  // No subroutines in a non-trivial program
  if (n === 0 && lines >= 300) {
    return { points: max, max, note: 'No subroutines declared in a ' + (lines || 'non-trivial') + '-line program. Linear /FREE-or-monolith structure.' };
  }

  // Average lines per subroutine (rough estimate)
  let avgSize = 0;
  if (n > 0 && lines) avgSize = Math.round(lines / n);

  if (n === 0)           return { points: Math.round(max * 0.50), max, note: 'Subroutine count unknown or zero.' };
  if (avgSize > 300)     return { points: Math.round(max * 0.85), max, note: n + ' subroutines averaging ~' + avgSize + ' lines each. Long subroutines — candidate for extraction to procedures.' };
  if (avgSize > 150)     return { points: Math.round(max * 0.60), max, note: n + ' subroutines averaging ~' + avgSize + ' lines each. Moderate modularity.' };
  if (n >= 5)            return { points: Math.round(max * 0.25), max, note: n + ' subroutines, reasonable decomposition. Minor debt from BEGSR/ENDSR pattern versus ILE procedures.' };
  return                        { points: Math.round(max * 0.40), max, note: n + ' subroutine(s). Limited decomposition.' };
}

// 8. OCCURS overflow risk.
function scoreOccurs(summary) {
  const max = WEIGHTS.occurs;
  const occ = asArray(summary.occurs_ds);
  if (occ.length === 0) return { points: 0, max, note: 'No OCCURS data structures.' };

  // Look for fixed capacity fields
  let flagged = 0;
  for (const o of occ) {
    const t = asText(o);
    // OCCURS with small/medium capacity or where note suggests overflow risk
    if (/overflow|risk|rnx0100|unbounded|fixed/.test(t)) flagged++;
    const m = t.match(/occurs[^0-9]{0,10}(\d+)/);
    if (m) {
      const cap = parseInt(m[1], 10);
      if (cap > 0 && cap <= 999) flagged++;
    }
  }
  if (flagged >= 2)              return { points: max,                    max, note: occ.length + ' OCCURS data structures, ' + flagged + ' with fixed-capacity overflow risk (potential RNX0100).' };
  if (flagged === 1)             return { points: Math.round(max * 0.65), max, note: occ.length + ' OCCURS data structure(s), one flagged for overflow risk.' };
  return                                { points: Math.round(max * 0.35), max, note: occ.length + ' OCCURS data structure(s). Review capacity sizing.' };
}

// 9. LDA dependency.
// key_variables is structured data from Pass 1 — a literal *LDA entry
// there means the program genuinely references the LDA, regardless of
// what the patterns prose says. patterns is free text where negation
// handling matters ("No LDA" must not register as LDA usage).
function scoreLda(summary) {
  const max = WEIGHTS.lda;
  const p   = asText(summary.patterns);
  const kv  = asText(summary.key_variables);

  // Structured signal — key_variables literals
  const kvHasLda    = /\*lda|\blda\b/.test(kv);
  const kvHasDtaAra = /dtaara|data area/.test(kv);

  // Free-text signal — patterns prose with negation awareness
  const pHasLda    = hasPresent(p, /\blda\b|\*lda|local data area/, 'lda|\\*lda|local data area');
  const pHasDtaAra = hasPresent(p, /\bdata area\b|\bdtaara\b/,       'data area|dtaara');

  const usesLda    = kvHasLda    || pHasLda;
  const usesDtaAra = kvHasDtaAra || pHasDtaAra;

  if (usesLda && usesDtaAra) return { points: max, max, note: 'LDA plus other data area dependencies. Job-scoped state that does not exist outside the 5250 session.' };
  if (usesLda)               return { points: Math.round(max * 0.80), max, note: 'LDA dependency detected. Job-scoped state — must be replicated at wrapper boundary for API exposure.' };
  if (usesDtaAra)            return { points: Math.round(max * 0.55), max, note: 'Data area dependency (not LDA). State management at wrapper boundary required.' };
  return                            { points: 0, max, note: 'No LDA or data area dependency detected.' };
}

// ---------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------
/**
 * Compute the Modernisation Debt Score for a single RPG program.
 *
 * @param {Object} summary              Pass 1 JSON summary from analyse.js
 * @param {Object} [sourceCodeMeta]     Optional metadata about the raw source
 * @param {number} [sourceCodeMeta.lineCount]
 * @returns {{
 *   score:    number,    // 0-100
 *   level:    string,    // LOW | MEDIUM | HIGH | CRITICAL
 *   color:    string,    // hex colour for UI
 *   band:     string,    // one-line description of the level
 *   components: Object,  // per-dimension breakdown { name: {points, max, note} }
 *   headline: string,    // single-sentence summary
 *   generated_at: string // ISO timestamp
 * }}
 */
function computeDebtScore(summary, sourceCodeMeta) {
  if (!summary || typeof summary !== 'object') {
    return {
      score: 0,
      level: 'UNKNOWN',
      color: '#6b7280',
      band: 'Summary unavailable. Debt score cannot be computed.',
      components: {},
      headline: 'Modernisation Debt Score unavailable — no analysis summary produced.',
      generated_at: new Date().toISOString(),
    };
  }

  const components = {
    format:             scoreFormat(summary, sourceCodeMeta),
    error_handling:     scoreErrorHandling(summary, sourceCodeMeta),
    commitment_control: scoreCommitmentControl(summary),
    indicators:         scoreIndicators(summary),
    hardcoded:          scoreHardcoded(summary),
    size:               scoreSize(summary, sourceCodeMeta),
    modularity:         scoreModularity(summary, sourceCodeMeta),
    occurs:             scoreOccurs(summary),
    lda:                scoreLda(summary),
  };

  let total = 0;
  for (const key of Object.keys(components)) total += components[key].points;
  total = Math.max(0, Math.min(100, Math.round(total)));

  const cls = classify(total);

  // Build the three highest-debt dimensions for the headline
  const topDebt = Object.entries(components)
    .map(([k, v]) => ({ key: k, ratio: v.max ? v.points / v.max : 0, note: v.note }))
    .filter(x => x.ratio > 0.5)
    .sort((a, b) => b.ratio - a.ratio)
    .slice(0, 3)
    .map(x => DIMENSION_LABELS[x.key]);

  let headline;
  if (total === 0) {
    headline = 'No material modernisation debt detected. Program is well-structured for its era.';
  } else if (topDebt.length === 0) {
    headline = 'Debt is distributed across several dimensions with no single dominant factor.';
  } else {
    headline = 'Primary debt concentration: ' + topDebt.join(', ') + '.';
  }

  return {
    score:        total,
    level:        cls.level,
    color:        cls.color,
    band:         cls.band,
    components:   components,
    headline:     headline,
    generated_at: new Date().toISOString(),
  };
}

const DIMENSION_LABELS = {
  format:             'Format',
  error_handling:     'Error Handling',
  commitment_control: 'Commitment Control',
  indicators:         'Indicator Usage',
  hardcoded:          'Hardcoded Values',
  size:               'Program Size',
  modularity:         'Modularity',
  occurs:             'OCCURS Overflow Risk',
  lda:                'LDA Dependency',
};

module.exports = {
  computeDebtScore,
  WEIGHTS,
  LEVELS,
  DIMENSION_LABELS,
};
