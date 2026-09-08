"use strict";

const application = require("./server/application");

if (require.main === module) application.run();

module.exports = application;
