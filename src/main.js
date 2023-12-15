/*
    Search Service

    Copyright (C) LiveG. All Rights Reserved.

    https://search.liveg.tech
    Licensed by the LiveG Open-Source Licence, which can be found at LICENCE.md.
*/

const express = require("express");

const package = require("../package.json");

var app = express();

app.use(function(request, response, next) {
    response.header("Access-Control-Allow-Origin", "*");

    next();
});

app.get("/api/search", function(request, response) {
    response.send({
        status: "ok",
        version: package.version,
        vernum: package.vernum
    });
});

app.use(function(request, response, next) {
    response.status(404);

    response.send({
        status: "error",
        code: "invalidEndpoint",
        message: "The endpoint requested is invalid."
    });
});

app.listen(process.argv[2], function() {
    console.log(`LiveG Search Service started on port ${process.argv[2]}`);
});