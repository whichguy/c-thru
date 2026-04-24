function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {
  /**
   * usaw_ntp_selection - NTP Level Assignment Tool
   *
   * Calculate NTP level assignments (Gold/Silver/Bronze/Developmental)
   * based on 2026 NTP Policy.
   *
   * ELIGIBILITY RULES:
   * - Gold/Silver/Bronze: ANY athlete (Youth, Junior, Senior) vs SENIOR standards
   * - Developmental: ONLY Youth/Junior athletes vs THEIR OWN age group standards
   *
   * Params:
   *   ntp_period_start! - Start date of NTP period (YYYY-MM-DD)
   *   gender - 'M' or 'F' to filter results (optional)
   *   output_format - 'summary', 'detailed', or 'raw' (default: summary)
   *   athletes - Array of athlete performance objects
   *
   * Athlete object format:
   *   { athleteId/name, birthYear, gender, weightClass, total, eventName, date }
   *
   * Returns:
   *   {success, ntp_period, qualifying_period, levels, total_qualified}
   */

  let UsawStandards, UsawEventClassifier;
  try {
    UsawStandards = require('tools/helpers/UsawStandards');
  } catch (e) {
    return {
      success: false,
      error: 'Helper loading failed',
      details: `UsawStandards: ${e.toString()}`
    };
  }

  try {
    UsawEventClassifier = require('tools/helpers/UsawEventClassifier');
  } catch (e) {
    return {
      success: false,
      error: 'Helper loading failed',
      details: `UsawEventClassifier: ${e.toString()}`
    };
  }

  const ntpPeriodStart = input.ntp_period_start;
  if (!ntpPeriodStart) {
    return {
      success: false,
      error: 'ntp_period_start is required',
      hints: [
        'Provide date as YYYY-MM-DD',
        'Jan-Jun periods: qualifying year is previous calendar year',
        'Jul-Dec periods: qualifying period is Jul 1 - Jun 30'
      ]
    };
  }

  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ntpPeriodStart);
  if (!dateMatch) {
    return {
      success: false,
      error: `Invalid date format: ${ntpPeriodStart}`,
      hints: ['Use YYYY-MM-DD format']
    };
  }

  const testDate = new Date(ntpPeriodStart);
  if (isNaN(testDate.getTime())) {
    return {
      success: false,
      error: `Invalid date: ${ntpPeriodStart}`
    };
  }

  thinking(`Calculating NTP selection for period starting ${ntpPeriodStart}`);

  const qualifyingPeriod = UsawStandards.getQualifyingPeriod(ntpPeriodStart);
  thinking(`Qualifying period: ${qualifyingPeriod.start} to ${qualifyingPeriod.end}`);

  if (!UsawStandards.STANDARDS[qualifyingPeriod.standardsYear]) {
    return {
      success: false,
      error: `No standards data for qualifying year ${qualifyingPeriod.standardsYear}`
    };
  }

  let athletes = input.athletes || [];

  if (!athletes || athletes.length === 0) {
    return {
      success: true,
      ntp_period: {
        start: ntpPeriodStart,
        type: testDate.getMonth() < 6 ? 'Period 1 (Jan-Jun)' : 'Period 2 (Jul-Dec)'
      },
      qualifying_period: qualifyingPeriod,
      levels: {
        gold: { M: [], F: [], slots: 6, requirement: 'ANY athlete, Senior A, international' },
        silver: { M: [], F: [], slots: 6, requirement: 'ANY athlete, Senior A/B, international' },
        bronze: { M: [], F: [], slots: 2, requirement: 'ANY athlete age<=23, Senior A/B, int\'l/national' },
        developmental: { total: [], slots: 25, requirement: 'ONLY Youth/Junior, own age group A/B, int\'l/national' }
      },
      total_qualified: 0,
      hints: [
        'No athletes provided.',
        'Pass athletes: [{name, birthYear, gender, weightClass, total, eventName, date}, ...]'
      ]
    };
  }

  thinking(`Processing ${athletes.length} athlete performances`);

  let genderFilter = null;
  if (input.gender) {
    genderFilter = input.gender.toUpperCase();
    if (genderFilter !== 'M' && genderFilter !== 'F') {
      return { success: false, error: `Invalid gender: ${input.gender}` };
    }
  }

  thinking('Running NTP level assignment algorithm...');
  const result = UsawStandards.assignNTPLevels(athletes, ntpPeriodStart);

  const outputFormat = (input.output_format || 'summary').toLowerCase();

  let gold = { M: result.gold.M, F: result.gold.F };
  let silver = { M: result.silver.M, F: result.silver.F };
  let bronze = { M: result.bronze.M, F: result.bronze.F };
  let developmental = result.developmental;

  if (genderFilter) {
    gold = { [genderFilter]: gold[genderFilter] || [] };
    silver = { [genderFilter]: silver[genderFilter] || [] };
    bronze = { [genderFilter]: bronze[genderFilter] || [] };
    developmental = developmental.filter(a => a.gender === genderFilter);
  }

  const goldCount = (gold.M?.length || 0) + (gold.F?.length || 0);
  const silverCount = (silver.M?.length || 0) + (silver.F?.length || 0);
  const bronzeCount = (bronze.M?.length || 0) + (bronze.F?.length || 0);
  const devCount = developmental.length;
  const totalQualified = goldCount + silverCount + bronzeCount + devCount;

  thinking(`Selection complete: ${totalQualified} athletes qualified`);

  function formatAthlete(a, format) {
    if (format === 'raw') return a;
    if (format === 'detailed') {
      return {
        name: a.name || a.athleteId,
        gender: a.gender,
        weightClass: a.weightClass,
        total: a.total,
        percentOfA: a.level === 'developmental' ? a.percentOfAgeGroupA : a.percentOfSeniorA,
        ageGroup: a.ageGroup,
        sportingAge: a.sportingAge,
        event: a.eventName || a.competition,
        eventType: a.eventType,
        date: a.date || a.competitionDate,
        level: a.level
      };
    }
    return {
      name: a.name || a.athleteId,
      gender: a.gender,
      weightClass: a.weightClass,
      total: a.total,
      percentOfA: a.level === 'developmental' ? a.percentOfAgeGroupA : a.percentOfSeniorA
    };
  }

  const fmt = (list) => list.map(a => formatAthlete(a, outputFormat));

  return {
    success: true,
    ntp_period: {
      start: ntpPeriodStart,
      type: testDate.getMonth() < 6 ? 'Period 1 (Jan-Jun)' : 'Period 2 (Jul-Dec)'
    },
    qualifying_period: qualifyingPeriod,
    levels: {
      gold: {
        M: fmt(gold.M || []),
        F: fmt(gold.F || []),
        count: goldCount,
        slots: 6,
        requirement: 'ANY athlete, Senior A Standard, international event'
      },
      silver: {
        M: fmt(silver.M || []),
        F: fmt(silver.F || []),
        count: silverCount,
        slots: 6,
        requirement: 'ANY athlete, Senior A or B Standard, international event'
      },
      bronze: {
        M: fmt(bronze.M || []),
        F: fmt(bronze.F || []),
        count: bronzeCount,
        slots: 2,
        requirement: 'ANY athlete age<=23, Senior A or B, international or national'
      },
      developmental: {
        athletes: fmt(developmental),
        count: devCount,
        slots: 25,
        min_per_gender: 5,
        requirement: 'ONLY Youth/Junior, own age group A or B, international or national'
      }
    },
    total_qualified: totalQualified,
    unqualified_count: result.unqualified?.length || 0
  };
}

__defineModule__(_main);
