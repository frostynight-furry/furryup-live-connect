// Copyright (c) 2026 FrostyNight. See LICENSE.
'use strict';
const { PROFILE_PLATFORMS, identifyProfile, exactCount, ProfileError } = require('./model');
const { createFollowerClient } = require('./client');
module.exports = { PROFILE_PLATFORMS, identifyProfile, exactCount, ProfileError, createFollowerClient };
