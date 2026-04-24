function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {
// ╔═══════════════════════════════════════════════════════════════════════════╗
// ║ LLM BREADCRUMB: UsawStandards                                             ║
// ╠═══════════════════════════════════════════════════════════════════════════╣
// ║ PURPOSE: NTP tier assignment (Gold/Silver/Bronze/Dev) from performance    ║
// ║ ENTRY:   assignNTPLevels(athletes[], ntpPeriodStart) → tiered results     ║
// ║ LOOKUP:  getStandard(year, ageGroup, gender, weightClass) → {a, b}        ║
// ║ PERIOD:  getQualifyingPeriod(date) → {start, end, standardsYear}          ║
// ║ PARSE:   parseWeightClassLabel("Women's Youth 58kg") → {cat, kg}          ║
// ║ TIERS:   Gold(intl+A,top6) > Silver(intl+A/B,top6) >                     ║
// ║          Bronze(intl/natl+A/B,≤23,top2) > Dev(age-std,intl/natl,top25)    ║
// ║ EVENTS:  Gold/Silver: INTERNATIONAL only (Olympics, Worlds, Pan Am, etc)  ║
// ║          Bronze/Dev: International OR National (+ USAW Nationals, Virus)  ║
// ║ KNOWN:   2025 weight class transition may miscategorize mid-2025 comps    ║
// ╚═══════════════════════════════════════════════════════════════════════════╝

/**
 * USAW Qualifying Standards and NTP Selection Calculator
 *
 * AGE GROUPS (by sporting age):
 * - U15: ages ≤14 (single standard, no A/B distinction)
 * - Youth: ages 15-17
 * - Junior: ages 18-20
 * - Senior: ages 21+
 *
 * IMPORTANT LEVEL ELIGIBILITY:
 * - Gold/Silver/Bronze: ANY athlete (U15, Youth, Junior, Senior) - measured against SENIOR standards
 * - Developmental: ONLY U15/Youth/Junior athletes - measured against THEIR OWN age group standards
 *
 * QUALIFYING EVENT TYPES (per 2026 NTP Policy):
 * - Gold & Silver: INTERNATIONAL events only (Olympics, Pan Am Games/Championships,
 *   IWF World Championships Senior/Junior/Youth, FISU, Junior Pan Am, Olympic Qual Events)
 * - Bronze & Developmental: All international events PLUS national events
 *   (USAW National Championships, USAW Virus Series, USAW-designated "national" events)
 *
 * @module tools/helpers/UsawStandards
 */

// ============================================================================
// QUALIFYING STANDARDS DATA
// ============================================================================

// KNOWN LIMITATION - 2025 Weight Class Transition:
// Mid-2025 competitions at old IWF classes (55kg, 61kg, 62kg, etc.) may be
// mis-categorized by the API into new classes (56kg, 60kg, 65kg). Example:
// Gabe Chhum at Pan Am (bodyweight 60.01kg, 275kg total) appears as 65kg
// (B=289kg → Bronze) instead of 60kg (B=267kg → Silver). USAW evaluates by
// actual bodyweight, but we use API-reported class. This will self-correct
// as new competitions are recorded under correct weight classes.

// NEW Weight Classes (effective 2025):
// Senior/Junior Men: 60, 65, 71, 79, 88, 94, 110, 110+
// Senior/Junior Women: 48, 53, 58, 63, 69, 77, 86, 86+
// Youth/U15 Men: 56, 60, 65, 71, 79, 88, 94, 94+
// Youth/U15 Women: 44, 48, 53, 58, 63, 69, 77, 77+
const STANDARDS = {
  2025: {
    Senior: {
      M: {
        60: { a: 281, b: 267 }, 65: { a: 304, b: 289 }, 71: { a: 325, b: 309 },
        79: { a: 347, b: 330 }, 88: { a: 367, b: 349 }, 94: { a: 376, b: 357 },
        110: { a: 388, b: 369 }, '+110': { a: 410, b: 390 }
      },
      F: {
        48: { a: 181, b: 172 }, 53: { a: 199, b: 189 }, 58: { a: 215, b: 204 },
        63: { a: 225, b: 214 }, 69: { a: 233, b: 221 }, 77: { a: 238, b: 226 },
        86: { a: 242, b: 230 }, '+86': { a: 263, b: 250 }
      }
    },
    Junior: {
      M: {
        60: { a: 253, b: 239 }, 65: { a: 274, b: 258 }, 71: { a: 293, b: 276 },
        79: { a: 312, b: 295 }, 88: { a: 330, b: 312 }, 94: { a: 338, b: 320 },
        110: { a: 349, b: 330 }, '+110': { a: 369, b: 349 }
      },
      F: {
        48: { a: 163, b: 154 }, 53: { a: 179, b: 169 }, 58: { a: 194, b: 183 },
        63: { a: 203, b: 191 }, 69: { a: 210, b: 198 }, 77: { a: 214, b: 202 },
        86: { a: 218, b: 206 }, '+86': { a: 237, b: 224 }
      }
    },
    Youth: {
      M: {
        56: { a: 207, b: 194 }, 60: { a: 225, b: 211 }, 65: { a: 243, b: 228 },
        71: { a: 260, b: 244 }, 79: { a: 278, b: 260 }, 88: { a: 294, b: 275 },
        94: { a: 301, b: 282 }, '+94': { a: 310, b: 291 }
      },
      F: {
        44: { a: 130, b: 122 }, 48: { a: 145, b: 136 }, 53: { a: 159, b: 149 },
        58: { a: 172, b: 161 }, 63: { a: 180, b: 169 }, 69: { a: 186, b: 175 },
        77: { a: 190, b: 179 }, '+77': { a: 194, b: 182 }
      }
    },
    U15: {
      // Standard U15 weight classes + 11/13 Under Age Group weight classes
      // Lighter classes (30-40kg for F, 32-52kg for M) estimated from progression
      M: {
        32: { a: 92 }, 36: { a: 105 }, 40: { a: 120 }, 44: { a: 135 },
        48: { a: 150 }, 52: { a: 165 },
        56: { a: 181 }, 60: { a: 197 }, 65: { a: 213 }, '+65': { a: 220 },
        71: { a: 228 }, 79: { a: 243 }, 88: { a: 257 }, 94: { a: 263 }, '+94': { a: 272 }
      },
      F: {
        30: { a: 68 }, 33: { a: 78 }, 36: { a: 88 }, 40: { a: 100 },
        44: { a: 113 }, 48: { a: 127 }, 53: { a: 139 }, 58: { a: 151 },
        63: { a: 158 }, '+63': { a: 162 }, 69: { a: 163 }, 77: { a: 167 }, '+77': { a: 169 }
      }
    }
  },
  2026: {
    Senior: {
      M: {
        60: { a: 281, b: 267 }, 65: { a: 304, b: 289 }, 71: { a: 325, b: 309 },
        79: { a: 347, b: 330 }, 88: { a: 367, b: 349 }, 94: { a: 376, b: 357 },
        110: { a: 388, b: 369 }, '+110': { a: 410, b: 390 }
      },
      F: {
        48: { a: 181, b: 172 }, 53: { a: 199, b: 189 }, 58: { a: 215, b: 204 },
        63: { a: 225, b: 214 }, 69: { a: 233, b: 221 }, 77: { a: 238, b: 226 },
        86: { a: 242, b: 230 }, '+86': { a: 263, b: 250 }
      }
    },
    Junior: {
      M: {
        60: { a: 253, b: 239 }, 65: { a: 274, b: 258 }, 71: { a: 293, b: 276 },
        79: { a: 312, b: 295 }, 88: { a: 330, b: 312 }, 94: { a: 338, b: 320 },
        110: { a: 349, b: 330 }, '+110': { a: 369, b: 349 }
      },
      F: {
        48: { a: 163, b: 154 }, 53: { a: 179, b: 169 }, 58: { a: 194, b: 183 },
        63: { a: 203, b: 191 }, 69: { a: 210, b: 198 }, 77: { a: 214, b: 202 },
        86: { a: 218, b: 206 }, '+86': { a: 237, b: 224 }
      }
    },
    Youth: {
      M: {
        56: { a: 207, b: 194 }, 60: { a: 225, b: 211 }, 65: { a: 243, b: 228 },
        71: { a: 260, b: 244 }, 79: { a: 278, b: 260 }, 88: { a: 294, b: 275 },
        94: { a: 301, b: 282 }, '+94': { a: 310, b: 291 }
      },
      F: {
        44: { a: 130, b: 122 }, 48: { a: 145, b: 136 }, 53: { a: 159, b: 149 },
        58: { a: 172, b: 161 }, 63: { a: 180, b: 169 }, 69: { a: 186, b: 175 },
        77: { a: 190, b: 179 }, '+77': { a: 194, b: 182 }
      }
    },
    U15: {
      // Standard U15 weight classes + 11/13 Under Age Group weight classes
      M: {
        32: { a: 92 }, 36: { a: 105 }, 40: { a: 120 }, 44: { a: 135 },
        48: { a: 150 }, 52: { a: 165 },
        56: { a: 181 }, 60: { a: 197 }, 65: { a: 213 }, '+65': { a: 220 },
        71: { a: 228 }, 79: { a: 243 }, 88: { a: 257 }, 94: { a: 263 }, '+94': { a: 272 }
      },
      F: {
        30: { a: 68 }, 33: { a: 78 }, 36: { a: 88 }, 40: { a: 100 },
        44: { a: 113 }, 48: { a: 127 }, 53: { a: 139 }, 58: { a: 151 },
        63: { a: 158 }, '+63': { a: 162 }, 69: { a: 163 }, 77: { a: 167 }, '+77': { a: 169 }
      }
    }
  }
};

// ============================================================================
// QUALIFYING PERIOD CALCULATION
// ============================================================================

/**
 * Calculate NTP and Qualifying periods based on a reference date.
 *
 * NTP Periods run in 6-month cycles:
 *   - Jan 1 - Jun 30 (H1)
 *   - Jul 1 - Dec 31 (H2)
 *
 * Qualifying Period is always the 12 months ending at the start of the NTP period:
 *   - H1 (Jan-Jun): Qualifying = previous calendar year (Jan 1 - Dec 31)
 *   - H2 (Jul-Dec): Qualifying = Jul 1 prior year to Jun 30 current year
 *
 * @param {string|Date} [referenceDate] - Any date to determine NTP period (defaults to today)
 * @returns {Object} { ntpPeriod: {start, end}, start, end, standardsYear }
 */
function getQualifyingPeriod(referenceDate) {
  let year, month;

  if (!referenceDate) {
    // Default to current date
    const now = new Date();
    year = now.getFullYear();
    month = now.getMonth(); // 0-indexed
  } else if (typeof referenceDate === 'string') {
    // Parse from string to avoid timezone issues
    year = parseInt(referenceDate.substring(0, 4), 10);
    month = parseInt(referenceDate.substring(5, 7), 10) - 1; // Convert to 0-indexed
  } else {
    // Date object
    year = referenceDate.getFullYear();
    month = referenceDate.getMonth();
  }

  if (month < 6) {
    // Jan-Jun NTP Period (H1)
    // NTP Period: Jan 1 - Jun 30 of current year
    // Qualifying: Jan 1 - Dec 31 of previous year
    // Standards: previous year
    return {
      ntpPeriod: {
        start: year + '-01-01',
        end: year + '-06-30',
        half: 'H1'
      },
      start: (year - 1) + '-01-01',
      end: (year - 1) + '-12-31',
      standardsYear: year - 1
    };
  } else {
    // Jul-Dec NTP Period (H2)
    // NTP Period: Jul 1 - Dec 31 of current year
    // Qualifying: Jan 1 - Dec 31 of current year (full calendar year)
    // Standards: current year
    return {
      ntpPeriod: {
        start: year + '-07-01',
        end: year + '-12-31',
        half: 'H2'
      },
      start: year + '-01-01',
      end: year + '-12-31',
      standardsYear: year
    };
  }
}

/**
 * Check if a performance date falls within qualifying period
 * @param {string|Date} performanceDate - Competition date
 * @param {Object} qualifyingPeriod - From getQualifyingPeriod()
 * @returns {boolean}
 */
function isWithinQualifyingPeriod(performanceDate, qualifyingPeriod) {
  const perfDate = new Date(performanceDate);
  const startDate = new Date(qualifyingPeriod.start);
  const endDate = new Date(qualifyingPeriod.end);

  startDate.setHours(0, 0, 0, 0);
  endDate.setHours(23, 59, 59, 999);
  perfDate.setHours(12, 0, 0, 0);

  return perfDate >= startDate && perfDate <= endDate;
}

// ============================================================================
// AGE AND CATEGORY CALCULATIONS
// ============================================================================

/** @param {number} birthYear @param {string} ntpPeriodStart @returns {number} sporting age */
function calculateSportingAge(birthYear, ntpPeriodStart) {
  const d = new Date(ntpPeriodStart);
  return d.getFullYear() - birthYear;
}

/** @param {number} sportingAge @returns {'Youth'|'Junior'|'Senior'} */
function getAgeGroup(sportingAge) {
  // U15 (≤14) treated as Youth for NTP purposes
  if (sportingAge <= 17) return 'Youth';
  if (sportingAge <= 20) return 'Junior';
  return 'Senior';
}

// ============================================================================
// STANDARD CALCULATIONS
// ============================================================================

/** @param {number} total @param {number} aStandard @returns {number} percentage with 3 decimals */
function calculatePercentOfA(total, aStandard) {
  if (!aStandard || aStandard <= 0) return 0;
  return Math.round((total / aStandard) * 100000) / 1000;
}

/**
 * Lookup A/B standards for a specific weight class
 * @param {number} year - Standards year (2025, 2026)
 * @param {'U15'|'Youth'|'Junior'|'Senior'} ageGroup
 * @param {'M'|'F'} gender
 * @param {number|string} weightClass - e.g., 65 or '+110'
 * @returns {{a: number, b?: number}|null}
 */
function getStandard(year, ageGroup, gender, weightClass) {
  const yearData = STANDARDS[year];
  if (!yearData) return null;

  const ageData = yearData[ageGroup];
  if (!ageData) return null;

  const genderData = ageData[gender];
  if (!genderData) return null;

  const wc = String(weightClass);
  return genderData[wc] || genderData[parseInt(wc, 10)] || null;
}

/**
 * Get all standards matching filters
 * @param {number} year
 * @param {{ageGroup?: string, gender?: string, weightClass?: string}} filters
 * @returns {Array<{year, age_group, gender, weight_class, a_standard, b_standard}>}
 */
function getStandards(year, filters = {}) {
  const yearData = STANDARDS[year];
  if (!yearData) return [];

  const results = [];
  const ageGroups = filters.ageGroup ? [filters.ageGroup] : Object.keys(yearData);
  const genders = filters.gender ? [filters.gender] : ['M', 'F'];

  for (const ag of ageGroups) {
    const ageData = yearData[ag];
    if (!ageData) continue;

    for (const g of genders) {
      const genderData = ageData[g];
      if (!genderData) continue;

      for (const [wc, std] of Object.entries(genderData)) {
        if (filters.weightClass && String(filters.weightClass) !== String(wc)) continue;

        results.push({
          year: year,
          age_group: ag,
          gender: g,
          weight_class: wc,
          a_standard: std.a,
          b_standard: std.b || std.a  // U15 has single standard (no B), fallback to A
        });
      }
    }
  }

  return results;
}

/** @param {number} total @param {number} aStandard @returns {boolean} */
function meetsAStandard(total, aStandard) {
  return total >= aStandard;
}

/** @param {number} total @param {number} bStandard @returns {boolean} */
function meetsBStandard(total, bStandard) {
  return total >= bStandard;
}

// ============================================================================
// NTP LEVEL ASSIGNMENT
// ============================================================================

/**
 * Assign NTP levels to athletes - MAIN ENTRY POINT
 *
 * TIER LOGIC (athletes ranked by % of Senior A standard, descending):
 * - Gold: Top 6/gender, Senior A, INTERNATIONAL qualifying event only. NO age restriction.
 * - Silver: Top 6/gender, Senior A or B, INTERNATIONAL qualifying event only. Includes A-standard overflow from Gold.
 * - Bronze: Top 2/gender, Senior A or B, international OR national event, sporting age ≤23.
 * - Developmental: Top 25 universal, ONLY Youth/Junior, own age-group A or B, international OR national event.
 *
 * @param {Array<Object>} athletes - Performances with: name, gender, total, date, weightClass/wcKg, eventLevel/level
 * @param {string} ntpPeriodStart - ISO date for NTP period (determines qualifying window)
 * @returns {{gold: {M: [], F: []}, silver: {M: [], F: []}, bronze: {M: [], F: []}, developmental: [], upAndComing: [], unqualified: []}}
 */
function assignNTPLevels(athletes, ntpPeriodStart) {
  const EventClassifier = require('tools/helpers/UsawEventClassifier');
  const qualifyingPeriod = getQualifyingPeriod(ntpPeriodStart);

  log('[UsawStandards] Qualifying period: ' + JSON.stringify(qualifyingPeriod));

  // ========== Load ineligible athletes from _NTP_Ineligible sheet ==========
  const ineligibleSet = new Set();
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName('_NTP_Ineligible');
    if (sheet && sheet.getLastRow() > 1) {
      const data = sheet.getDataRange().getValues();
      for (let i = 1; i < data.length; i++) {  // Skip header
        const name = String(data[i][0] || '').trim().toLowerCase();
        const hid = String(data[i][2] || '').trim();
        if (name) ineligibleSet.add(name);
        if (hid) ineligibleSet.add('hid:' + hid);
      }
      log('[UsawStandards] Loaded ' + ineligibleSet.size + ' ineligible athlete entries');
    }
  } catch (e) {
    log('[UsawStandards] Warning: Could not load _NTP_Ineligible: ' + e.message);
  }

  // Helper to check ineligibility
  const isIneligible = (a) => {
    const nameKey = (a.name || '').trim().toLowerCase();
    const hidKey = a.hid ? 'hid:' + a.hid : null;
    return ineligibleSet.has(nameKey) || (hidKey && ineligibleSet.has(hidKey));
  };

  // ========== EARLY FILTER: Remove ineligible athletes ==========
  const eligibleAthletes = athletes.filter(a => {
    if (ineligibleSet.size > 0 && isIneligible(a)) {
      log('[UsawStandards] Excluding ineligible: ' + a.name);
      return false;
    }
    return true;
  });

  // Filter to qualifying period (use eligibleAthletes instead of athletes)
  const validPerformances = eligibleAthletes.filter(a => {
    return isWithinQualifyingPeriod(a.date || a.competitionDate, qualifyingPeriod);
  });

  log('[UsawStandards] Performances in qualifying period: ' + validPerformances.length);

  // Process each performance
  const processed = validPerformances.map(a => {
    // Determine age group - priority order:
    // 1. lifter_age (ACTUAL athlete age from API - most accurate!)
    // 2. birthYear (calculated sporting age)
    // 3. Weight class label (for age-specific classes like "14-15", "U13")
    // 4. querySource (u15/junior/youth/open)
    // 5. Default to Senior
    let sportingAge, ageGroup;

    // PRIMARY: Use actual lifter_age if available (most accurate!)
    // This ensures a 15-year-old in "Junior 69kg" is evaluated as Youth
    if (a.lifter_age) {
      sportingAge = a.lifter_age;
      ageGroup = getAgeGroup(sportingAge);
    }
    // SECONDARY: Calculate from birthYear
    else if (a.birthYear) {
      sportingAge = calculateSportingAge(a.birthYear, ntpPeriodStart);
      ageGroup = getAgeGroup(sportingAge);
    }

    // FALLBACK: Try parsing from weight class label (e.g., "Women's 14-15 58kg")
    if (!ageGroup) {
      const wcLabel = a.wcLabel || a.weight_class_label || a.weightClassLabel;
      if (wcLabel) {
        const parsed = parseWeightClassLabel(wcLabel);
        if (parsed.cat !== 'Open') {
          ageGroup = parsed.cat;
          // Assign representative sporting age for the category
          // Note: U15 now returns 'Youth' from parseWeightClassLabel
          if (ageGroup === 'Youth') sportingAge = 16;
          else if (ageGroup === 'Junior') sportingAge = 19;
        }
      }
    }

    // FALLBACK: Try querySource (u15 treated as Youth)
    if (!ageGroup && a.querySource === 'u15') {
      ageGroup = 'Youth';
      sportingAge = 13;
    } else if (!ageGroup && a.querySource === 'youth') {
      ageGroup = 'Youth';
      sportingAge = 16;
    } else if (!ageGroup && a.querySource === 'junior') {
      ageGroup = 'Junior';
      sportingAge = 19;
    }

    // DEFAULT: Senior if no age info available
    if (!ageGroup) {
      ageGroup = 'Senior';
      sportingAge = 25;
    }
    const total = a.total || (a.snatch + a.cleanJerk);

    // Normalize weight class field (tool uses wcKg, other sources use weightClass)
    const weightClass = a.weightClass || a.wcKg;

    // SENIOR standards - used for Gold/Silver/Bronze (ANY athlete)
    const seniorStandard = getStandard(qualifyingPeriod.standardsYear, 'Senior', a.gender, weightClass);

    // AGE GROUP standards - used for Developmental
    // U15 athletes (now classified as Youth) use Youth standards
    const devAgeGroup = ageGroup;
    const ageGroupStandard = getStandard(qualifyingPeriod.standardsYear, devAgeGroup, a.gender, weightClass);

      // Determine event type from API's level field (preferred) or fallback to pattern matching
      // API level values can be NUMERIC (3=National, 4=International) or STRING
      // Priority: 1. eventLevel (numeric), 2. level (numeric or string), 3. EventClassifier fallback
      let eventType = 'local';
      const levelVal = a.level;
      // Convert to string safely - handles null, undefined, numbers, and strings
      const levelStr = String(levelVal == null ? '' : levelVal).toLowerCase();

      // Check for International: eventLevel=4, level=4, or level="International"
      if (a.eventLevel === 4 || a.eventLevel === '4' ||
          levelVal === 4 || levelVal === '4' ||
          levelStr === 'international') {
        eventType = 'international';
      }
      // Check for National: eventLevel=3, level=3, or level="National"/"North American Open Series"
      else if (a.eventLevel === 3 || a.eventLevel === '3' ||
               levelVal === 3 || levelVal === '3' ||
               levelStr === 'national' ||
               levelStr === 'north american open series') {
        eventType = 'national';
      } else if (levelStr === 'local' || levelVal === 1 || levelVal === '1' || levelVal === 2 || levelVal === '2') {
        eventType = 'local';
      } else if (a.eventName && a.eventName !== 'Unknown') {
        // Only fall back to EventClassifier if API didn't provide a level
        eventType = EventClassifier.classifyEvent(a.eventName || a.competition);
      }

    return {
      ...a,
      sportingAge,
      ageGroup,
      total,
      eventType,

      // Senior standards (Gold/Silver/Bronze eligibility)
      seniorA: seniorStandard?.a || 0,
      seniorB: seniorStandard?.b || 0,
      meetsSeniorA: seniorStandard ? meetsAStandard(total, seniorStandard.a) : false,
      meetsSeniorB: seniorStandard ? meetsBStandard(total, seniorStandard.b) : false,
      percentOfSeniorA: seniorStandard ? calculatePercentOfA(total, seniorStandard.a) : 0,

      // Age group standards (Developmental eligibility - U15/Youth/Junior only)
      // Note: U15 has single standard (no B), so fallback to 'a' value
      ageGroupA: ageGroupStandard?.a || 0,
      ageGroupB: ageGroupStandard?.b || ageGroupStandard?.a || 0,
      meetsAgeGroupA: ageGroupStandard ? meetsAStandard(total, ageGroupStandard.a) : false,
      meetsAgeGroupB: ageGroupStandard ? meetsBStandard(total, ageGroupStandard.b || ageGroupStandard.a) : false,
      percentOfAgeGroupA: ageGroupStandard ? calculatePercentOfA(total, ageGroupStandard.a) : 0
    };
  });

  // Phase 9 Fix: Deduplicate preserving BOTH international AND national performances
  // Gold/Silver require international events - we must not discard international performances
  // even if national performance has higher total
  const bestByAthleteIntl = {};  // Best international performance per athlete
  const bestByAthleteNatl = {};  // Best national/other performance per athlete

  for (const p of processed) {
    const key = p.athleteId || p.name || (p.firstName + ' ' + p.lastName);

    if (p.eventType === 'international') {
      if (!bestByAthleteIntl[key] || p.percentOfSeniorA > bestByAthleteIntl[key].percentOfSeniorA) {
        bestByAthleteIntl[key] = p;
      }
    } else {
      // National or local
      if (!bestByAthleteNatl[key] || p.percentOfSeniorA > bestByAthleteNatl[key].percentOfSeniorA) {
        bestByAthleteNatl[key] = p;
      }
    }
  }

  // Merge: include international performance if exists, otherwise use national/other
  // This ensures athletes with international performances get those considered for Gold/Silver
  const bestByAthlete = {};
  for (const key of new Set([...Object.keys(bestByAthleteIntl), ...Object.keys(bestByAthleteNatl)])) {
    const intl = bestByAthleteIntl[key];
    const natl = bestByAthleteNatl[key];

    if (intl && natl) {
      // Has both - keep whichever has higher %, but mark with both performances available
      if (intl.percentOfSeniorA >= natl.percentOfSeniorA) {
        bestByAthlete[key] = { ...intl, _hasNationalPerformance: true, _nationalTotal: natl.total };
      } else {
        // National is higher, but still need international for Gold/Silver eligibility
        // Store international data for tier checks
        bestByAthlete[key] = {
          ...natl,
          _hasInternationalPerformance: true,
          _internationalTotal: intl.total,
          _internationalEventType: intl.eventType,
          _internationalMeetsSeniorA: intl.meetsSeniorA,
          _internationalMeetsSeniorB: intl.meetsSeniorB,
          _internationalPercentOfSeniorA: intl.percentOfSeniorA
        };
      }
    } else {
      bestByAthlete[key] = intl || natl;
    }
  }
  const deduplicated = Object.values(bestByAthlete);

  log('[UsawStandards] Unique athletes: ' + deduplicated.length);

  // Sort by % of Senior A DESC, then earliest date
  deduplicated.sort((a, b) => {
    if (b.percentOfSeniorA !== a.percentOfSeniorA) {
      return b.percentOfSeniorA - a.percentOfSeniorA;
    }
    return new Date(a.date || a.competitionDate) - new Date(b.date || b.competitionDate);
  });

  const result = {
    gold: { M: [], F: [] },
    silver: { M: [], F: [] },
    bronze: { M: [], F: [] },
    developmental: [],
    upAndComing: [],
    unqualified: []
  };

  const assigned = new Set();

  // =========================================================================
  // GOLD: Top 6 per gender (NO age restriction)
  // - Must meet SENIOR A Standard at INTERNATIONAL qualifying event
  //   (Olympics, Pan Am, IWF Worlds, FISU, Olympic Qual Events)
  // - Athletes ranked by % of Senior A standard descending
  // Phase 9: Check both primary performance AND stored international performance
  // =========================================================================
  for (const p of deduplicated) {
    if (assigned.has(p.athleteId || p.name)) continue;

    // Check if athlete has a qualifying international performance
    // Case 1: Primary performance is international and meets Senior A
    // Case 2: Has stored international performance that meets Senior A
    let qualifiesForGold = false;
    let goldPerformance = p;

    if (p.eventType === 'international' && p.meetsSeniorA) {
      qualifiesForGold = true;
    } else if (p._hasInternationalPerformance && p._internationalMeetsSeniorA) {
      // Use the international performance data for Gold eligibility
      qualifiesForGold = true;
      // Create a representation with international performance data
      goldPerformance = {
        ...p,
        total: p._internationalTotal,
        eventType: 'international',
        meetsSeniorA: p._internationalMeetsSeniorA,
        percentOfSeniorA: p._internationalPercentOfSeniorA
      };
    }

    if (!qualifiesForGold) continue;

    const genderList = result.gold[p.gender];
    if (genderList && genderList.length < 6) {
      genderList.push({ ...goldPerformance, level: 'gold' });
      assigned.add(p.athleteId || p.name);
    }
  }

  // =========================================================================
  // SILVER: Top 6 per gender (not in Gold, NO age restriction)
  // - Must meet SENIOR A or B Standard at INTERNATIONAL qualifying event
  // - Includes Senior A athletes who overflowed from Gold (>6 per gender)
  // Phase 9: Check both primary performance AND stored international performance
  // =========================================================================
  for (const p of deduplicated) {
    if (assigned.has(p.athleteId || p.name)) continue;

    // Check if athlete has a qualifying international performance
    let qualifiesForSilver = false;
    let silverPerformance = p;

    if (p.eventType === 'international' && (p.meetsSeniorA || p.meetsSeniorB)) {
      qualifiesForSilver = true;
    } else if (p._hasInternationalPerformance && (p._internationalMeetsSeniorA || p._internationalMeetsSeniorB)) {
      qualifiesForSilver = true;
      silverPerformance = {
        ...p,
        total: p._internationalTotal,
        eventType: 'international',
        meetsSeniorA: p._internationalMeetsSeniorA,
        meetsSeniorB: p._internationalMeetsSeniorB,
        percentOfSeniorA: p._internationalPercentOfSeniorA
      };
    }

    if (!qualifiesForSilver) continue;

    const genderList = result.silver[p.gender];
    if (genderList && genderList.length < 6) {
      genderList.push({ ...silverPerformance, level: 'silver' });
      assigned.add(p.athleteId || p.name);
    }
  }

  // =========================================================================
  // BRONZE: Top 2 per gender (not in Gold/Silver)
  // - Must meet SENIOR A or B Standard
  // - Sporting age must be <= 23
  // - International OR National qualifying event (broader than Gold/Silver)
  // =========================================================================
  for (const p of deduplicated) {
    if (assigned.has(p.athleteId || p.name)) continue;
    if (!p.meetsSeniorA && !p.meetsSeniorB) continue;
    if (p.sportingAge > 23) continue;
    // Bronze requires national or international event (use pre-computed eventType)
    if (p.eventType !== 'national' && p.eventType !== 'international') continue;

    const genderList = result.bronze[p.gender];
    if (genderList && genderList.length < 2) {
      genderList.push({ ...p, level: 'bronze' });
      assigned.add(p.athleteId || p.name);
    }
  }

  // =========================================================================
  // DEVELOPMENTAL: Top 25 UNIVERSAL (men & women combined, min 5 per gender)
  // - ONLY U15, Youth, or Junior athletes (NOT Senior)
  // - Must meet A or B Standard in THEIR OWN age group
  //   (U15 has single standard treated as both A and B)
  // - International OR National qualifying event (broader than Gold/Silver)
  // - Ranked by % of age group A standard (universal sort, not by gender)
  // - Uses ALL processed performances, then deduplicates by highest percentOfAgeGroupA
  //   (not pre-deduplicated by Senior A, which would miss better age-group performances)
  // =========================================================================
  const allDevEligible = processed.filter(p => {
    if (assigned.has(p.athleteId || p.name)) return false;

    // CRITICAL: Only Youth and Junior - Senior athletes CANNOT qualify for Developmental
    // (U15 athletes now have ageGroup = 'Youth')
    if (!['Youth', 'Junior'].includes(p.ageGroup)) return false;

    // Must meet their OWN age group standard (U15/Youth/Junior, NOT Senior)
    if (!p.meetsAgeGroupA && !p.meetsAgeGroupB) return false;

    // Developmental requires national or international event (use pre-computed eventType)
    if (p.eventType !== 'national' && p.eventType !== 'international') return false;
    return true;
  });

  // Deduplicate: keep HIGHEST percentOfAgeGroupA per athlete
  // This ensures a Youth athlete's best Youth-standard performance is kept,
  // rather than their best Senior-standard performance
  const bestDevByAthlete = {};
  for (const p of allDevEligible) {
    const key = p.athleteId || p.name || (p.firstName + ' ' + p.lastName);
    if (!bestDevByAthlete[key] || p.percentOfAgeGroupA > bestDevByAthlete[key].percentOfAgeGroupA) {
      bestDevByAthlete[key] = p;
    }
  }
  const devCandidates = Object.values(bestDevByAthlete);

  // UNIVERSAL SORT: All candidates (men & women combined) by % of age group A standard descending
  devCandidates.sort((a, b) => {
    if (b.percentOfAgeGroupA !== a.percentOfAgeGroupA) {
      return b.percentOfAgeGroupA - a.percentOfAgeGroupA;
    }
    // Tiebreaker: earliest date
    return new Date(a.date || a.competitionDate) - new Date(b.date || b.competitionDate);
  });

  // Top 25 for Developmental (universal ranking, no gender quotas)
  result.developmental = devCandidates.slice(0, 25).map((p, idx) => ({
    ...p,
    level: 'developmental',
    devRank: idx + 1  // Universal rank 1-25
  }));

  // Next 25 for "Up and Coming" list (ranks 26-50)
  result.upAndComing = devCandidates.slice(25, 50).map((p, idx) => ({
    ...p,
    level: 'up_and_coming',
    devRank: idx + 26  // Rank 26-35
  }));

  for (const p of result.developmental) {
    assigned.add(p.athleteId || p.name);
  }
  for (const p of result.upAndComing) {
    assigned.add(p.athleteId || p.name);
  }

  // Unqualified
  result.unqualified = deduplicated
    .filter(p => !assigned.has(p.athleteId || p.name))
    .map(p => ({ ...p, level: 'unqualified' }));

  return result;
}

// ============================================================================
// PERFORMANCE IMPROVEMENT CHECK
// ============================================================================

/** Check if athlete improved by 1%+ over previous total @returns {boolean} */
function meetsPerformanceImprovement(prevTotal, currentPeriodBestTotal) {
  const requiredImprovement = Math.round(prevTotal * 1.01);
  return currentPeriodBestTotal >= requiredImprovement;
}

// ============================================================================
// WEIGHT CLASS PARSING HELPERS
// ============================================================================

/**
 * Parse a USAW weight class label like "Women's Youth 58kg" or "Men's 96kg"
 * Handles multiple age-specific formats:
 * - "Women's 13 Under Age Group 53kg" → U15
 * - "Men's U11 56kg", "Women's U13 48kg", "Men's U15 65kg" → U15
 * - "Women's 14-15 58kg" → Youth (or U15 for 14)
 * - "Men's 16-17 71kg" → Youth
 * - "Women's 18-20 63kg" → Junior
 * - "Men's Junior 79kg" → Junior
 * - "Women's Youth 58kg" → Youth
 * @param {string} label - Weight class label from API
 * @returns {Object} { cat: 'Youth'|'Open'|'Junior'|'U15', kg: number, isMasters: boolean, ageRange: string|null }
 */
function parseWeightClassLabel(label) {
  const result = { cat: 'Open', kg: null, isMasters: false, ageRange: null };

  if (!label || typeof label !== 'string') return result;

  // Check for Masters
  if (/masters/i.test(label)) {
    result.isMasters = true;
  }

  // Extract category from label - order matters (most specific first)

  // 1. Check for age ranges like "14-15", "16-17", "18-20"
  const ageRangeMatch = label.match(/(\d{1,2})-(\d{1,2})/);
  if (ageRangeMatch) {
    const minAge = parseInt(ageRangeMatch[1], 10);
    const maxAge = parseInt(ageRangeMatch[2], 10);
    result.ageRange = ageRangeMatch[0];

    // Map age ranges to categories based on USAW age groups
    // U15: ≤14, Youth: 15-17, Junior: 18-20, Senior: 21+
    if (maxAge <= 14) {
      result.cat = 'Youth';  // U15 treated as Youth for NTP
    } else if (maxAge <= 17) {
      result.cat = 'Youth';
    } else if (maxAge <= 20) {
      result.cat = 'Junior';
    }
  }
  // 2. Check for U11, U13, U15 patterns - treat as Youth
  else if (/\bU1[135]\b/i.test(label)) {
    result.cat = 'Youth';
  }
  // 3. Handle "13 Under", "11 Under", "15 Under" - treat as Youth
  else if (/\d+\s*under/i.test(label)) {
    result.cat = 'Youth';
  }
  // 4. Explicit Youth keyword
  else if (/youth/i.test(label)) {
    result.cat = 'Youth';
  }
  // 5. Explicit Junior keyword
  else if (/junior/i.test(label)) {
    result.cat = 'Junior';
  }

  // Extract weight - MUST end with "kg" to avoid matching age numbers like "13 Under"
  // Matches: 53kg, 63+kg, +94kg, 94+kg (but NOT "13 Under")
  const kgMatch = label.match(/(\+?)(\d+)(\+?)\s*kg/i);
  if (kgMatch) {
    const hasPlus = kgMatch[1] || kgMatch[3];
    result.kg = hasPlus ? '+' + kgMatch[2] : parseInt(kgMatch[2], 10);
  }

  return result;
}

/**
 * Infer gender from weight class label
 * @param {string} label - Weight class label from API
 * @returns {string} 'M' or 'F'
 */
function inferGender(label) {
  if (!label || typeof label !== 'string') return 'M';

  // Check explicit gender markers
  if (/women|female|girl/i.test(label)) return 'F';
  if (/men|male|boy/i.test(label)) return 'M';

  // Check by weight class range (women's classes are generally lighter)
  const kgMatch = label.match(/(\d+)/);
  if (kgMatch) {
    const kg = parseInt(kgMatch[1], 10);
    // Women's heaviest is 86+, men's lightest is 56
    if (kg <= 48) return 'F';  // Definitely women's
    if (kg >= 94) return 'M';  // Definitely men's
  }

  return 'M'; // Default to men
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  STANDARDS,
  getQualifyingPeriod,
  isWithinQualifyingPeriod,
  calculateSportingAge,
  getAgeGroup,
  getStandard,
  getStandards,
  calculatePercentOfA,
  meetsAStandard,
  meetsBStandard,
  meetsPerformanceImprovement,
  assignNTPLevels,
  parseWeightClassLabel,
  inferGender
};
}
__defineModule__(_main);