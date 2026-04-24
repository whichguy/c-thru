function _main(
  module = globalThis.__getCurrentModule(),
  exports = module.exports,
  log = globalThis.__getModuleLogFunction?.(module) || (() => {})
) {
  /**
   * Test suite for gas-queue module
   * Tests all three backing stores: Cache, Properties, Drive
   */

  const QueueManager = require('gas-queue/QueueManager');

  /**
   * Test helper functions
   */
  const TestHelpers = {
    /**
     * Assert equality with descriptive error
     */
    assertEqual(actual, expected, message) {
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(`${message}\nExpected: ${JSON.stringify(expected)}\nActual: ${JSON.stringify(actual)}`);
      }
    },

    /**
     * Assert truthy value
     */
    assertTrue(value, message) {
      if (!value) {
        throw new Error(`${message}\nExpected truthy, got: ${value}`);
      }
    },

    /**
     * Assert falsy value
     */
    assertFalse(value, message) {
      if (value) {
        throw new Error(`${message}\nExpected falsy, got: ${value}`);
      }
    },

    /**
     * Assert array length
     */
    assertLength(array, expectedLength, message) {
      if (array.length !== expectedLength) {
        throw new Error(`${message}\nExpected length: ${expectedLength}\nActual length: ${array.length}`);
      }
    },

    /**
     * Run a test with error handling
     */
    runTest(testName, testFn) {
      try {
        Logger.log(`\n▶ Running: ${testName}`);
        testFn();
        Logger.log(`✓ Passed: ${testName}`);
        return {name: testName, passed: true};
      } catch (error) {
        Logger.log(`✗ Failed: ${testName}`);
        Logger.log(`  Error: ${error.message}`);
        return {name: testName, passed: false, error: error.message};
      }
    },

    /**
     * Generate unique channel name for test
     */
    getTestChannel(testName) {
      return `TEST_${testName}_${Date.now()}`;
    }
  };

  /**
   * Test basic post and pickup operations
   */
  function testBasicPostPickup(storeType) {
    const channel = TestHelpers.getTestChannel('basic_post_pickup');
    const queue = new QueueManager({store: storeType, namespace: 'TEST'});

    // Post messages
    TestHelpers.assertTrue(
      queue.post(channel, 'message1'),
      'Post message1 should succeed'
    );
    TestHelpers.assertTrue(
      queue.post(channel, 'message2'),
      'Post message2 should succeed'
    );
    TestHelpers.assertTrue(
      queue.post(channel, 'message3'),
      'Post message3 should succeed'
    );

    // Verify size
    TestHelpers.assertEqual(
      queue.size(channel),
      3,
      'Queue should contain 3 messages'
    );

    // Pickup messages (FIFO order)
    const msg1 = queue.pickup(channel);
    TestHelpers.assertLength(msg1, 1, 'Should pickup 1 message');
    TestHelpers.assertEqual(msg1[0].data, 'message1', 'First message should be message1');

    const msg2 = queue.pickup(channel);
    TestHelpers.assertEqual(msg2[0].data, 'message2', 'Second message should be message2');

    TestHelpers.assertEqual(
      queue.size(channel),
      1,
      'Queue should contain 1 message after 2 pickups'
    );

    // Cleanup
    queue.flush(channel);
  }

  /**
   * Test peek operation (non-destructive)
   */
  function testPeekOperation(storeType) {
    const channel = TestHelpers.getTestChannel('peek');
    const queue = new QueueManager({store: storeType, namespace: 'TEST'});

    // Post messages
    queue.post(channel, 'peek1');
    queue.post(channel, 'peek2');
    queue.post(channel, 'peek3');

    // Peek without removing
    const peeked1 = queue.peek(channel);
    TestHelpers.assertLength(peeked1, 1, 'Peek should return 1 message');
    TestHelpers.assertEqual(peeked1[0].data, 'peek1', 'Peek should show first message');

    // Size should not change
    TestHelpers.assertEqual(
      queue.size(channel),
      3,
      'Queue size should remain 3 after peek'
    );

    // Peek multiple
    const peeked3 = queue.peek(channel, 3);
    TestHelpers.assertLength(peeked3, 3, 'Peek should return 3 messages');
    TestHelpers.assertEqual(peeked3[0].data, 'peek1', 'First peeked message');
    TestHelpers.assertEqual(peeked3[1].data, 'peek2', 'Second peeked message');
    TestHelpers.assertEqual(peeked3[2].data, 'peek3', 'Third peeked message');

    // Size still unchanged
    TestHelpers.assertEqual(
      queue.size(channel),
      3,
      'Queue size should still be 3 after multiple peek'
    );

    // Cleanup
    queue.flush(channel);
  }

  /**
   * Test bulk pickup operations
   */
  function testBulkPickup(storeType) {
    const channel = TestHelpers.getTestChannel('bulk_pickup');
    const queue = new QueueManager({store: storeType, namespace: 'TEST'});

    // Post 5 messages
    for (let i = 1; i <= 5; i++) {
      queue.post(channel, `bulk${i}`);
    }

    // Pickup 3 messages at once
    const batch1 = queue.pickup(channel, 3);
    TestHelpers.assertLength(batch1, 3, 'Should pickup 3 messages');
    TestHelpers.assertEqual(batch1[0].data, 'bulk1', 'First in batch');
    TestHelpers.assertEqual(batch1[1].data, 'bulk2', 'Second in batch');
    TestHelpers.assertEqual(batch1[2].data, 'bulk3', 'Third in batch');

    // Remaining size
    TestHelpers.assertEqual(
      queue.size(channel),
      2,
      'Queue should have 2 messages remaining'
    );

    // Pickup remaining
    const batch2 = queue.pickup(channel, 3); // Request 3, should get 2
    TestHelpers.assertLength(batch2, 2, 'Should pickup 2 remaining messages');
    TestHelpers.assertEqual(batch2[0].data, 'bulk4', 'Fourth message');
    TestHelpers.assertEqual(batch2[1].data, 'bulk5', 'Fifth message');

    // Queue empty
    TestHelpers.assertEqual(
      queue.size(channel),
      0,
      'Queue should be empty'
    );

    // Cleanup
    queue.flush(channel);
  }

  /**
   * Test flush operation
   */
  function testFlushChannel(storeType) {
    const channel = TestHelpers.getTestChannel('flush');
    const queue = new QueueManager({store: storeType, namespace: 'TEST'});

    // Post messages
    queue.post(channel, 'flush1');
    queue.post(channel, 'flush2');
    queue.post(channel, 'flush3');

    TestHelpers.assertEqual(queue.size(channel), 3, 'Queue should have 3 messages');

    // Flush
    queue.flush(channel);

    TestHelpers.assertEqual(queue.size(channel), 0, 'Queue should be empty after flush');

    // Pickup from empty queue
    const empty = queue.pickup(channel);
    TestHelpers.assertLength(empty, 0, 'Pickup from empty queue should return empty array');
  }

  /**
   * Test multi-channel support
   */
  function testMultipleChannels(storeType) {
    const channel1 = TestHelpers.getTestChannel('multi_ch1');
    const channel2 = TestHelpers.getTestChannel('multi_ch2');
    const queue = new QueueManager({store: storeType, namespace: 'TEST'});

    // Post to different channels
    queue.post(channel1, 'ch1_msg1');
    queue.post(channel1, 'ch1_msg2');
    queue.post(channel2, 'ch2_msg1');
    queue.post(channel2, 'ch2_msg2');
    queue.post(channel2, 'ch2_msg3');

    // Verify sizes
    TestHelpers.assertEqual(queue.size(channel1), 2, 'Channel 1 should have 2 messages');
    TestHelpers.assertEqual(queue.size(channel2), 3, 'Channel 2 should have 3 messages');

    // List channels
    const channels = queue.channels();
    TestHelpers.assertTrue(
      channels.includes(channel1),
      'Channels should include channel1'
    );
    TestHelpers.assertTrue(
      channels.includes(channel2),
      'Channels should include channel2'
    );

    // Pickup from channel1
    const msg1 = queue.pickup(channel1);
    TestHelpers.assertEqual(msg1[0].data, 'ch1_msg1', 'Should get ch1_msg1');

    // Channel2 should be unchanged
    TestHelpers.assertEqual(queue.size(channel2), 3, 'Channel 2 should still have 3 messages');

    // Cleanup
    queue.flush(channel1);
    queue.flush(channel2);
  }

  /**
   * Test metadata support
   */
  function testMetadata(storeType) {
    const channel = TestHelpers.getTestChannel('metadata');
    const queue = new QueueManager({store: storeType, namespace: 'TEST'});

    // Post with metadata
    queue.post(channel, 'data1', {priority: 'high', source: 'api'});
    queue.post(channel, 'data2', {priority: 'low', source: 'ui'});

    // Pickup and verify metadata
    const msg1 = queue.pickup(channel);
    TestHelpers.assertEqual(msg1[0].data, 'data1', 'First message data');
    TestHelpers.assertEqual(msg1[0].metadata.priority, 'high', 'Metadata priority');
    TestHelpers.assertEqual(msg1[0].metadata.source, 'api', 'Metadata source');

    const msg2 = queue.pickup(channel);
    TestHelpers.assertEqual(msg2[0].metadata.priority, 'low', 'Second message metadata');

    // Cleanup
    queue.flush(channel);
  }

  /**
   * Test generator iteration
   */
  function testGeneratorIteration(storeType) {
    const channel = TestHelpers.getTestChannel('generator');
    const queue = new QueueManager({store: storeType, namespace: 'TEST'});

    // Post 25 messages
    for (let i = 1; i <= 25; i++) {
      queue.post(channel, `gen${i}`);
    }

    // Iterate in batches of 10
    let batchCount = 0;
    let totalMessages = 0;

    for (const batch of queue.iterate(channel, 10)) {
      batchCount++;
      totalMessages += batch.length;
      
      // Verify batch order
      for (let i = 0; i < batch.length; i++) {
        const expectedNum = (batchCount - 1) * 10 + i + 1;
        TestHelpers.assertEqual(
          batch[i].data,
          `gen${expectedNum}`,
          `Batch ${batchCount} message ${i}`
        );
      }
    }

    TestHelpers.assertEqual(batchCount, 3, 'Should have 3 batches (10, 10, 5)');
    TestHelpers.assertEqual(totalMessages, 25, 'Should process all 25 messages');
    TestHelpers.assertEqual(queue.size(channel), 0, 'Queue should be empty after iteration');

    // Cleanup
    queue.flush(channel);
  }

  /**
   * Test stats reporting
   */
  function testStats(storeType) {
    const channel1 = TestHelpers.getTestChannel('stats_ch1');
    const channel2 = TestHelpers.getTestChannel('stats_ch2');
    const queue = new QueueManager({store: storeType, namespace: 'TEST'});

    // Post messages to multiple channels
    queue.post(channel1, 'msg1');
    queue.post(channel1, 'msg2');
    queue.post(channel2, 'msg3');

    // Get stats
    const stats = queue.stats();

    TestHelpers.assertTrue(stats.channels >= 2, 'Stats should show at least 2 channels');
    TestHelpers.assertTrue(stats.totalMessages >= 3, 'Stats should show at least 3 messages');
    TestHelpers.assertEqual(stats.store, storeType, 'Stats should show correct store type');
    TestHelpers.assertEqual(stats.namespace, 'TEST', 'Stats should show correct namespace');

    // Cleanup
    queue.flush(channel1);
    queue.flush(channel2);
  }

  /**
   * Test FIFO ordering with timestamps
   */
  function testFIFOOrdering(storeType) {
    const channel = TestHelpers.getTestChannel('fifo');
    const queue = new QueueManager({store: storeType, namespace: 'TEST'});

    const timestamps = [];

    // Post messages with small delay
    for (let i = 1; i <= 5; i++) {
      queue.post(channel, `fifo${i}`);
      timestamps.push(Date.now());
      Utilities.sleep(10); // Small delay to ensure different timestamps
    }

    // Pickup all
    const messages = queue.pickup(channel, 5);

    // Verify FIFO order
    for (let i = 0; i < messages.length; i++) {
      TestHelpers.assertEqual(
        messages[i].data,
        `fifo${i + 1}`,
        `Message ${i + 1} should be in FIFO order`
      );
      
      // Verify timestamps are increasing
      if (i > 0) {
        TestHelpers.assertTrue(
          messages[i].timestamp >= messages[i - 1].timestamp,
          `Timestamp ${i + 1} should be >= timestamp ${i}`
        );
      }
    }

    // Cleanup
    queue.flush(channel);
  }

  /**
   * Run all tests for a specific store type
   */
  function runStoreTests(storeType) {
    Logger.log(`\n${'='.repeat(60)}`);
    Logger.log(`Testing ${storeType.toUpperCase()} Store`);
    Logger.log('='.repeat(60));

    const results = [];

    results.push(TestHelpers.runTest(
      `${storeType}: Basic Post/Pickup`,
      () => testBasicPostPickup(storeType)
    ));

    results.push(TestHelpers.runTest(
      `${storeType}: Peek Operation`,
      () => testPeekOperation(storeType)
    ));

    results.push(TestHelpers.runTest(
      `${storeType}: Bulk Pickup`,
      () => testBulkPickup(storeType)
    ));

    results.push(TestHelpers.runTest(
      `${storeType}: Flush Channel`,
      () => testFlushChannel(storeType)
    ));

    results.push(TestHelpers.runTest(
      `${storeType}: Multiple Channels`,
      () => testMultipleChannels(storeType)
    ));

    results.push(TestHelpers.runTest(
      `${storeType}: Metadata Support`,
      () => testMetadata(storeType)
    ));

    results.push(TestHelpers.runTest(
      `${storeType}: Generator Iteration`,
      () => testGeneratorIteration(storeType)
    ));

    results.push(TestHelpers.runTest(
      `${storeType}: Stats Reporting`,
      () => testStats(storeType)
    ));

    results.push(TestHelpers.runTest(
      `${storeType}: FIFO Ordering`,
      () => testFIFOOrdering(storeType)
    ));

    return results;
  }

  /**
   * Run all tests for all store types
   */
  function testAllStores() {
    Logger.log('Starting gas-queue test suite...');
    Logger.log(`Timestamp: ${new Date().toISOString()}\n`);

    const allResults = [];

    // Test Cache store
    allResults.push(...runStoreTests('cache'));

    // Test Properties store
    allResults.push(...runStoreTests('properties'));

    // Test Drive store
    allResults.push(...runStoreTests('drive'));

    // Summary
    Logger.log(`\n${'='.repeat(60)}`);
    Logger.log('TEST SUMMARY');
    Logger.log('='.repeat(60));

    const passed = allResults.filter(r => r.passed).length;
    const failed = allResults.filter(r => !r.passed).length;

    Logger.log(`Total tests: ${allResults.length}`);
    Logger.log(`Passed: ${passed}`);
    Logger.log(`Failed: ${failed}`);

    if (failed > 0) {
      Logger.log(`\nFailed tests:`);
      allResults
        .filter(r => !r.passed)
        .forEach(r => Logger.log(`  ✗ ${r.name}\n    ${r.error}`));
    }

    Logger.log(`\nTest suite ${failed === 0 ? 'PASSED' : 'FAILED'}`);

    return {
      total: allResults.length,
      passed,
      failed,
      results: allResults
    };
  }

  /**
   * Quick test for Cache store only (default for thinking queue)
   */
  function testCacheStoreQuick() {
    Logger.log('Running quick Cache store tests...\n');
    const results = runStoreTests('cache');
    
    const passed = results.filter(r => r.passed).length;
    const failed = results.filter(r => !r.passed).length;
    
    Logger.log(`\nQuick test: ${passed}/${results.length} passed`);
    return {passed, failed, results};
  }

  /**
   * Integration test: Simulate thinking queue usage
   */
  function testThinkingQueueIntegration() {
    Logger.log('\n='.repeat(60));
    Logger.log('Integration Test: Thinking Queue Simulation');
    Logger.log('='.repeat(60));

    const channel = 'thinking';
    const queue = new QueueManager({store: 'cache', namespace: 'CLAUDE'});

    // Simulate posting thinking messages during API call
    Logger.log('\n1. Simulating API call posting thinking messages...');
    queue.post(channel, 'Analyzing request...', {type: 'thinking', step: 1});
    queue.post(channel, 'Searching codebase...', {type: 'thinking', step: 2});
    queue.post(channel, 'Generating response...', {type: 'thinking', step: 3});

    Logger.log(`   Posted 3 thinking messages`);
    Logger.log(`   Queue size: ${queue.size(channel)}`);

    // Simulate polling from client
    Logger.log('\n2. Simulating client polling...');
    Utilities.sleep(100); // Simulate delay

    const messages = queue.pickup(channel, 10);
    Logger.log(`   Picked up ${messages.length} messages`);

    messages.forEach((msg, i) => {
      Logger.log(`   [${i + 1}] ${msg.data} (step ${msg.metadata.step})`);
    });

    Logger.log(`   Queue size after pickup: ${queue.size(channel)}`);

    // Verify
    TestHelpers.assertLength(messages, 3, 'Should receive 3 thinking messages');
    TestHelpers.assertEqual(
      messages[0].data,
      'Analyzing request...',
      'First thinking message'
    );
    TestHelpers.assertEqual(queue.size(channel), 0, 'Queue should be empty');

    Logger.log('\n✓ Integration test passed');

    // Cleanup
    queue.flush(channel);
  }

  module.exports = {
    testAllStores,
    testCacheStoreQuick,
    testThinkingQueueIntegration,
    runStoreTests
  };
}

__defineModule__(_main);