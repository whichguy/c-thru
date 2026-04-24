function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {
  /**
   * Test modules organized by repo and type
   * Structure: { repo: { unit: [paths...], integration: [paths...] } }
   * 
   * File naming convention:
   * - Unit tests: {repo}/test/{ModuleName}.unit.test
   * - Integration tests: {repo}/test/{ModuleName}.integration.test
   */
  const TEST_MODULES = {
    'common-js': {
      unit: [
        // No unit tests exist yet for common-js
      ],
      integration: [
        // No integration tests exist yet for common-js
      ]
    },
    
    'chat-core': {
      unit: [
        'chat-core/test/FollowUpSuggestions.unit.test'
      ],
      integration: [
        'chat-core/test/ClaudeConversation.integration.test'
      ]
    },

    'sheets-chat': {
      unit: [
        'sheets-chat/test/AmbientEvaluator.unit.test',
        'sheets-chat/test/SchedulerTools.unit.test'
      ],
      integration: [
        'sheets-chat/test/ReadRangeTool.integration.test',
        'sheets-chat/test/ThreadContinuation.integration.test'
      ]
    },

    'then-later': {
      unit: [
        'then-later/test/FileUtils.unit.test',
        'then-later/test/JobExecutor.unit.test',
        'then-later/test/Entrypoints.unit.test'
      ],
      integration: [
        'then-later/test/DriveStorage.integration.test',
        'then-later/test/JobStateManager.integration.test',
        'then-later/test/JobRepository.integration.test',
        'then-later/test/JobBuilder.integration.test',
        'then-later/test/JobSchedulerUnit.integration.test',
        'then-later/test/SchedulerFlows.integration.test',
        'then-later/test/Notifications.integration.test',
        'then-later/test/ChainedFlows.integration.test'
      ]
    },
    
    'gas-queue': {
      unit: [
        // Add gas-queue unit tests here (if this repo exists)
      ],
      integration: [
        // Add gas-queue integration tests here (if this repo exists)
      ]
    },
    
    'tools': {
      unit: [],
      integration: [
        'tools/test/DynamicToolHandler.integration.test',
        'tools/test/UsawTools.integration.test'
      ]
    },
    
    'test-framework': {
      unit: [
        // Add test-framework unit tests here (tests for the test framework itself)
        // Example: 'test-framework/test/mocha-adapter.unit.test'
        // Example: 'test-framework/test/chai-assertions.unit.test'
      ],
      integration: [
        // Test framework integration tests
      ]
    },
    
    'knowledge-tests': {
      unit: [
        'knowledge-tests/Knowledge.unit.test'
      ],
      integration: [
        'knowledge-tests/Knowledge.integration.test',
        'knowledge-tests/Knowledge.e2e.test'
      ]
    }
  };

  /**
   * Cross-repo integration tests at root level
   * These tests verify interactions between different repos
   */
  const CROSS_REPO_INTEGRATION_TESTS = [
    // Add cross-repo integration tests here
    // Example: 'test-integration/ClaudeConversation-UrlFetchUtils.integration.test'
  ];

  /**
   * Discover all test module paths
   * @returns {Object} All test paths organized by repo and type (strings, not loaded modules)
   */
  function discoverAll() {
    const result = {};

    for (const [repo, types] of Object.entries(TEST_MODULES)) {
      result[repo] = {};
      for (const [type, paths] of Object.entries(types)) {
        result[repo][type] = paths.slice();
      }
    }

    result['cross-repo'] = {
      integration: CROSS_REPO_INTEGRATION_TESTS.slice()
    };

    return result;
  }

  /**
   * Discover only unit test paths
   * @returns {Object} Unit test paths organized by repo
   */
  function discoverUnitTests() {
    const result = {};

    for (const [repo, types] of Object.entries(TEST_MODULES)) {
      if (types.unit && types.unit.length > 0) {
        result[repo] = types.unit.slice();
      }
    }

    return result;
  }

  /**
   * Discover only integration test paths
   * @returns {Object} Integration test paths organized by repo
   */
  function discoverIntegrationTests() {
    const result = {};

    for (const [repo, types] of Object.entries(TEST_MODULES)) {
      if (types.integration && types.integration.length > 0) {
        result[repo] = types.integration.slice();
      }
    }

    result['cross-repo'] = CROSS_REPO_INTEGRATION_TESTS.slice();

    return result;
  }

  /**
   * Discover test paths for a specific repo
   * @param {string} repoName - Repository name
   * @returns {Object|null} Test paths for the repo organized by type
   */
  function discoverRepoTests(repoName) {
    if (!TEST_MODULES[repoName]) {
      return null;
    }

    const result = {};
    const repoTests = TEST_MODULES[repoName];

    for (const [type, paths] of Object.entries(repoTests)) {
      result[type] = paths.slice();
    }

    return result;
  }

  /**
   * Discover test paths for a specific repo and type
   * @param {string} repoName - Repository name
   * @param {string} type - Test type ('unit' or 'integration')
   * @returns {Array|null} Test paths for the repo and type
   */
  function discoverRepoTypeTests(repoName, type) {
    if (!TEST_MODULES[repoName] || !TEST_MODULES[repoName][type]) {
      return null;
    }

    return TEST_MODULES[repoName][type].slice();
  }

  /**
   * Get list of all registered test paths
   * @returns {Object} All test paths organized by repo and type
   */
  function listAllTestPaths() {
    return {
      byRepo: TEST_MODULES,
      crossRepo: CROSS_REPO_INTEGRATION_TESTS
    };
  }

  /**
   * Get count of registered tests
   * @returns {Object} Test counts by repo and type
   */
  function getTestCounts() {
    const counts = {
      byRepo: {},
      crossRepo: CROSS_REPO_INTEGRATION_TESTS.length,
      total: CROSS_REPO_INTEGRATION_TESTS.length
    };
    
    for (const [repo, types] of Object.entries(TEST_MODULES)) {
      const unitCount = types.unit ? types.unit.length : 0;
      const integrationCount = types.integration ? types.integration.length : 0;
      
      counts.byRepo[repo] = {
        unit: unitCount,
        integration: integrationCount,
        total: unitCount + integrationCount
      };
      
      counts.total += unitCount + integrationCount;
    }
    
    return counts;
  }

  // Export public API
  module.exports = {
    discoverAll,
    discoverUnitTests,
    discoverIntegrationTests,
    discoverRepoTests,
    discoverRepoTypeTests,
    listAllTestPaths,
    getTestCounts
  };
}

__defineModule__(_main);