// Copyright (c) 2026 FrostyNight. See LICENSE.
'use strict';
const { PROFILE_PLATFORMS, identifyProfile, exactCount, ProfileError } = require('./model');
const { createFollowerClient } = require('./client');
const { resolveProfile } = require('./resolver');
const { readDouyinPage } = require('./browser');
const { createProfileOAuth } = require('./oauth');
const { createBrowserServiceReader } = require('./service-client');
const { createConfiguredFollowerClient } = require('./provider');
const { createCreatorFollowerBrowser } = require('./creator-electron.cjs');
module.exports = { createCreatorFollowerBrowser, PROFILE_PLATFORMS, identifyProfile, exactCount, ProfileError, createFollowerClient, resolveProfile, readDouyinPage, createProfileOAuth, createBrowserServiceReader, createConfiguredFollowerClient };
