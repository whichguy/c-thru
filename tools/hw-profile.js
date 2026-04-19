#!/usr/bin/env node
'use strict';

function tierForGb(gb) {
  if (gb < 24) return '16gb';
  if (gb < 40) return '32gb';
  if (gb < 56) return '48gb';
  if (gb < 96) return '64gb';
  return '128gb';
}

module.exports = { tierForGb };
