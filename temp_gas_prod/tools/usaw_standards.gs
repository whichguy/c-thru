function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {
  /**
   * usaw_standards - USAW Qualifying Standards Tool
   *
   * Returns A/B qualifying standards for a given year.
   * Optionally filter by age_group, gender, weight_class.
   *
   * Params:
   *   year! - Standards year (required, 2025 or 2026)
   *   age_group - 'Youth', 'Junior', or 'Senior' (optional)
   *   gender - 'M' or 'F' (optional)
   *   weight_class - Weight class e.g., '67', '+87' (optional)
   *
   * Returns:
   *   {success, standards: [{year, age_group, gender, weight_class, a_standard, b_standard}], count, hints?, error?}
   */

  let UsawStandards;
  try {
    UsawStandards = require('tools/helpers/UsawStandards');
  } catch (e) {
    return {
      success: false,
      error: 'Helper loading failed',
      details: 'UsawStandards: ' + e.toString(),
      hints: ['Check that tools/helpers/UsawStandards.gs exists']
    };
  }

  const year = input.year;
  if (!year) {
    return {
      success: false,
      error: 'year is required',
      hints: ['Provide year as 2025 or 2026']
    };
  }

  const yearNum = parseInt(year, 10);
  if (isNaN(yearNum) || yearNum < 2020 || yearNum > 2030) {
    return {
      success: false,
      error: 'Invalid year: ' + year,
      hints: ['Year must be 2020-2030', 'Currently supported: 2025, 2026']
    };
  }

  thinking('Fetching standards for year ' + yearNum);

  if (!UsawStandards.STANDARDS[yearNum]) {
    return {
      success: false,
      error: 'No standards data for year ' + yearNum,
      hints: ['Currently supported years: 2025, 2026']
    };
  }

  const filters = {};

  if (input.age_group) {
    const validAgeGroups = ['Youth', 'Junior', 'Senior'];
    const ageGroup = input.age_group.charAt(0).toUpperCase() + input.age_group.slice(1).toLowerCase();
    if (!validAgeGroups.includes(ageGroup)) {
      return {
        success: false,
        error: 'Invalid age_group: ' + input.age_group,
        hints: ['Valid values: Youth, Junior, Senior']
      };
    }
    filters.ageGroup = ageGroup;
  }

  if (input.gender) {
    const gender = input.gender.toUpperCase();
    if (gender !== 'M' && gender !== 'F') {
      return {
        success: false,
        error: 'Invalid gender: ' + input.gender,
        hints: ['Valid values: M, F']
      };
    }
    filters.gender = gender;
  }

  if (input.weight_class) {
    filters.weightClass = String(input.weight_class);
  }

  const standards = UsawStandards.getStandards(yearNum, filters);

  thinking('Found ' + standards.length + ' standards');

  return {
    success: true,
    standards: standards,
    count: standards.length
  };
}

__defineModule__(_main);
