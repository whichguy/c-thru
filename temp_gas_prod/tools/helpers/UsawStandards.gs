function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {
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
   * @module tools/helpers/UsawStandards
   */

  // ============================================================================
  // QUALIFYING STANDARDS DATA
  // ============================================================================

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
          start: `${year}-01-01`,
          end: `${year}-06-30`,
          half: 'H1'
        },
        start: `${year - 1}-01-01`,
        end: `${year - 1}-12-31`,
        standardsYear: year - 1
      };
    } else {
      // Jul-Dec NTP Period (H2)
      // NTP Period: Jul 1 - Dec 31 of current year
      // Qualifying: Jul 1 prior year - Jun 30 current year
      // Standards: current year
      return {
        ntpPeriod: {
          start: `${year}-07-01`,
          end: `${year}-12-31`,
          half: 'H2'
        },
        start: `${year - 1}-07-01`,
        end: `${year}-06-30`,
        standardsYear: year
      };
    }
  }

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

  function calculateSportingAge(birthYear, ntpPeriodStart) {
    const d = new Date(ntpPeriodStart);
    return d.getFullYear() - birthYear;
  }

  function getAgeGroup(sportingAge) {
    if (sportingAge <= 14) return 'U15';
    if (sportingAge <= 17) return 'Youth';
    if (sportingAge <= 20) return 'Junior';
    return 'Senior';
  }

  // ============================================================================
  // STANDARD CALCULATIONS
  // ============================================================================

  function calculatePercentOfA(total, aStandard) {
    if (!aStandard || aStandard <= 0) return 0;
    return Math.round((total / aStandard) * 100000) / 1000;
  }

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

  function meetsAStandard(total, aStandard) {
    return total >= aStandard;
  }

  function meetsBStandard(total, bStandard) {
    return total >= bStandard;
  }

  // ============================================================================
  // NTP LEVEL ASSIGNMENT
  // ============================================================================

  /**
   * Assign NTP levels to athletes
   *
   * CRITICAL LOGIC:
   * - Gold/Silver/Bronze: ANY athlete, measured against SENIOR standards
   * - Developmental: ONLY U15/Youth/Junior, measured against THEIR OWN age group standards
   */
  function assignNTPLevels(athletes, ntpPeriodStart) {
    const EventClassifier = require('tools/helpers/UsawEventClassifier');
    const qualifyingPeriod = getQualifyingPeriod(ntpPeriodStart);

    log(`[UsawStandards] Qualifying period: ${JSON.stringify(qualifyingPeriod)}`);

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
          if (hid) ineligibleSet.add(`hid:${hid}`);
        }
        log(`[UsawStandards] Loaded ${ineligibleSet.size} ineligible athlete entries`);
      }
    } catch (e) {
      log(`[UsawStandards] Warning: Could not load _NTP_Ineligible: ${e.message}`);
    }

    // Helper to check ineligibility
    const isIneligible = (a) => {
      const nameKey = (a.name || '').trim().toLowerCase();
      const hidKey = a.hid ? `hid:${a.hid}` : null;
      return ineligibleSet.has(nameKey) || (hidKey && ineligibleSet.has(hidKey));
    };

    // ========== EARLY FILTER: Remove ineligible athletes ==========
    const eligibleAthletes = athletes.filter(a => {
      if (ineligibleSet.size > 0 && isIneligible(a)) {
        log(`[UsawStandards] Excluding ineligible: ${a.name}`);
        return false;
      }
      return true;
    });

    // Filter to qualifying period (use eligibleAthletes instead of athletes)
    const validPerformances = eligibleAthletes.filter(a => {
      return isWithinQualifyingPeriod(a.date || a.competitionDate, qualifyingPeriod);
    });

    log(`[UsawStandards] Performances in qualifying period: ${validPerformances.length}`);

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
            if (ageGroup === 'U15') sportingAge = 13;
            else if (ageGroup === 'Youth') sportingAge = 16;
            else if (ageGroup === 'Junior') sportingAge = 19;
          }
        }
      }

      // FALLBACK: Try querySource
      if (!ageGroup && a.querySource === 'u15') {
        ageGroup = 'U15';
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
      // U15 athletes use Youth standards (Developmental evaluates everyone against Youth or Junior A)
      const devAgeGroup = ageGroup === 'U15' ? 'Youth' : ageGroup;
      const ageGroupStandard = getStandard(qualifyingPeriod.standardsYear, devAgeGroup, a.gender, weightClass);

      // Determine event type from multiple sources:
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

    // ========== DIAGNOSTIC LOGGING: Tier Eligibility Analysis ==========
    const intlCount = processed.filter(p => p.eventType === 'international').length;
    const natlCount = processed.filter(p => p.eventType === 'national').length;
    const localCount = processed.filter(p => p.eventType === 'local').length;
    const meetsSeniorACount = processed.filter(p => p.meetsSeniorA).length;
    const meetsSeniorBCount = processed.filter(p => p.meetsSeniorB).length;
    const hasSeniorStd = processed.filter(p => p.seniorA > 0).length;
    const hasAgeGroupStd = processed.filter(p => p.ageGroupA > 0).length;
    log(`[DEBUG] Event types - intl: ${intlCount}, natl: ${natlCount}, local: ${localCount}`);
    log(`[DEBUG] Meets Senior A: ${meetsSeniorACount}, Meets Senior B: ${meetsSeniorBCount}`);
    log(`[DEBUG] Has Senior std (>0): ${hasSeniorStd}, Has AgeGroup std (>0): ${hasAgeGroupStd}`);
    // Sample first athlete for detailed debugging
    if (processed.length > 0) {
      const sample = processed[0];
      log(`[DEBUG] Sample athlete: ${JSON.stringify({
        name: sample.name || sample.athleteId,
        eventType: sample.eventType,
        eventLevel: sample.eventLevel,
        level: sample.level,
        total: sample.total,
        seniorA: sample.seniorA,
        seniorB: sample.seniorB,
        meetsSeniorA: sample.meetsSeniorA,
        meetsSeniorB: sample.meetsSeniorB,
        weightClass: sample.weightClass || sample.wcKg
      })}`);
    }
    // ========== END DIAGNOSTIC LOGGING ==========

    // =========================================================================
    // TIER ASSIGNMENT - Each tier filters directly from processed performances
    // Athletes can have multiple performances across weight classes at different
    // events. Each tier builds its own candidate list, deduplicates per athlete
    // (keeping highest % of A Standard), and assigns slots.
    // =========================================================================

    const result = {
      gold: { M: [], F: [] },
      silver: { M: [], F: [] },
      bronze: { M: [], F: [] },
      developmental: [],
      upAndComing: [],
      unqualified: []
    };

    const assigned = new Set();

    // Helper: deduplicate candidates by athlete, keeping highest percentOfSeniorA
    const _dedup = (candidates) => {
      const best = {};
      for (const p of candidates) {
        const key = p.athleteId || p.name || (`${p.firstName} ${p.lastName}`);
        if (!best[key] || p.percentOfSeniorA > best[key].percentOfSeniorA) {
          best[key] = p;
        }
      }
      return Object.values(best).sort((a, b) => {
        if (b.percentOfSeniorA !== a.percentOfSeniorA) return b.percentOfSeniorA - a.percentOfSeniorA;
        return new Date(a.date || a.competitionDate) - new Date(b.date || b.competitionDate);
      });
    };

    // =========================================================================
    // GOLD: Top 6 per gender
    // - ANY athlete (Youth, Junior, or Senior)
    // - Must meet SENIOR A Standard at INTERNATIONAL event
    // - Athletes can qualify via any weight class at any international event
    // =========================================================================
    const goldCandidates = processed.filter(p =>
      p.eventType === 'international' && p.meetsSeniorA
    );
    const goldRanked = _dedup(goldCandidates);

    log(`[UsawStandards] Gold candidates (deduped): ${goldRanked.length}`);

    for (const p of goldRanked) {
      if (assigned.has(p.athleteId || p.name)) continue;
      const genderList = result.gold[p.gender];
      if (genderList && genderList.length < 6) {
        genderList.push({ ...p, level: 'gold' });
        assigned.add(p.athleteId || p.name);
      }
    }

    // =========================================================================
    // SILVER: Top 6 per gender (not in Gold)
    // - ANY athlete (Youth, Junior, or Senior)
    // - Must meet SENIOR A or B Standard at INTERNATIONAL event
    // =========================================================================
    const silverCandidates = processed.filter(p =>
      !assigned.has(p.athleteId || p.name) &&
      p.eventType === 'international' &&
      (p.meetsSeniorA || p.meetsSeniorB)
    );
    const silverRanked = _dedup(silverCandidates);

    for (const p of silverRanked) {
      if (assigned.has(p.athleteId || p.name)) continue;
      const genderList = result.silver[p.gender];
      if (genderList && genderList.length < 6) {
        genderList.push({ ...p, level: 'silver' });
        assigned.add(p.athleteId || p.name);
      }
    }

    // =========================================================================
    // BRONZE: Top 2 per gender (not in Gold/Silver)
    // - ANY athlete (Youth, Junior, or Senior)
    // - Must meet SENIOR A or B Standard
    // - Sporting age must be <= 23
    // - International OR National event
    // =========================================================================
    const bronzeCandidates = processed.filter(p =>
      !assigned.has(p.athleteId || p.name) &&
      (p.meetsSeniorA || p.meetsSeniorB) &&
      p.sportingAge <= 23 &&
      (p.eventType === 'national' || p.eventType === 'international')
    );
    const bronzeRanked = _dedup(bronzeCandidates);

    for (const p of bronzeRanked) {
      if (assigned.has(p.athleteId || p.name)) continue;
      const genderList = result.bronze[p.gender];
      if (genderList && genderList.length < 2) {
        genderList.push({ ...p, level: 'bronze' });
        assigned.add(p.athleteId || p.name);
      }
    }

    // =========================================================================
    // DEVELOPMENTAL: Top 25 UNIVERSAL (men & women combined)
    // - ONLY U15, Youth, or Junior athletes (NOT Senior)
    // - Must meet A or B Standard in THEIR OWN age group
    //   (U15 has single standard treated as both A and B)
    // - International OR National event
    // - Ranked by % of age group A standard (universal sort, not by gender)
    // - Uses ALL processed performances, then deduplicates by highest percentOfAgeGroupA
    //   (not pre-deduplicated by Senior A, which would miss better age-group performances)
    // =========================================================================
    const allDevEligible = processed.filter(p => {
      if (assigned.has(p.athleteId || p.name)) return false;

      // CRITICAL: Only U15, Youth, and Junior - Senior athletes CANNOT qualify for Developmental
      if (!['U15', 'Youth', 'Junior'].includes(p.ageGroup)) return false;

      // Must meet their OWN age group standard (U15/Youth/Junior, NOT Senior)
      if (!p.meetsAgeGroupA && !p.meetsAgeGroupB) return false;

      // Developmental requires national or international event (use pre-computed eventType)
      if (p.eventType !== 'national' && p.eventType !== 'international') return false;
      return true;
    });

    // Deduplicate: keep HIGHEST percentOfAgeGroupA per athlete+weightClass
    // Athletes competing at multiple weight classes get separate candidacies
    const bestDevByAthlete = {};
    for (const p of allDevEligible) {
      const athleteId = p.athleteId || p.name || (`${p.firstName} ${p.lastName}`);
      const key = `${athleteId}|${String(p.weightClass || p.wcKg || '')}`;
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
    // Iterate with athlete uniqueness: same athlete at multiple weight classes takes only one slot
    const devSelected = [];
    const devSeen = new Set();
    for (const p of devCandidates) {
      const athleteId = p.athleteId || p.name;
      if (devSeen.has(athleteId) || assigned.has(athleteId)) continue;
      devSelected.push({ ...p, level: 'developmental', devRank: devSelected.length + 1 });
      devSeen.add(athleteId);
      if (devSelected.length >= 25) break;
    }
    result.developmental = devSelected;

    // Next 25 for "Up and Coming" list (ranks 26-50)
    const upAndComingSelected = [];
    for (const p of devCandidates) {
      const athleteId = p.athleteId || p.name;
      if (devSeen.has(athleteId) || assigned.has(athleteId)) continue;
      upAndComingSelected.push({ ...p, level: 'up_and_coming', devRank: devSelected.length + upAndComingSelected.length + 1 });
      devSeen.add(athleteId);
      if (upAndComingSelected.length >= 25) break;
    }
    result.upAndComing = upAndComingSelected;

    for (const p of result.developmental) {
      assigned.add(p.athleteId || p.name);
    }
    for (const p of result.upAndComing) {
      assigned.add(p.athleteId || p.name);
    }

    // Unqualified: dedup processed by athlete, keep best pctA, exclude assigned
    const unqBest = {};
    for (const p of processed) {
      const key = p.athleteId || p.name || (`${p.firstName} ${p.lastName}`);
      if (assigned.has(key)) continue;
      if (!unqBest[key] || p.percentOfSeniorA > unqBest[key].percentOfSeniorA) {
        unqBest[key] = p;
      }
    }
    result.unqualified = Object.values(unqBest)
      .map(p => ({ ...p, level: 'unqualified' }));

    return result;
  }

  // ============================================================================
  // PERFORMANCE IMPROVEMENT CHECK
  // ============================================================================

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
        result.cat = 'U15';
      } else if (maxAge <= 17) {
        result.cat = 'Youth';
      } else if (maxAge <= 20) {
        result.cat = 'Junior';
      }
    }
    // 2. Check for U11, U13, U15 patterns
    else if (/\bU1[135]\b/i.test(label)) {
      result.cat = 'U15';
    }
    // 3. Handle "13 Under", "11 Under", "15 Under" as U15 category
    else if (/\d+\s*under/i.test(label)) {
      result.cat = 'U15';
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
