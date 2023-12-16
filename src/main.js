/*
    Search Service

    Copyright (C) LiveG. All Rights Reserved.

    https://search.liveg.tech
    Licensed by the LiveG Open-Source Licence, which can be found at LICENCE.md.
*/

const path = require("path");
const qlc = require("@liveg/qlc");
const express = require("express");

const package = require("../package.json");

const MAX_KEYWORDS_IN_QUERY = 20;
const MAX_QUERY_LENGTH = 100;

var app = express();

var indexes = null;

function castObjectValues(object, keys, type) {
    keys.forEach(function(key) {
        object[key] = type(object[key]);
    });

    return object;
}

function tsvToObjects(data) {
    if (data.trim() == "") {
        return [];
    }

    var entries = data.split("\n").filter((entry) => entry != "");
    var fields = entries.shift().split("\t");

    return entries.map(function(entryText) {
        var entry = {};

        entryText = entryText.split("\t");

        fields.forEach(function(field, i) {
            entry[field] = entryText[i];
        });

        return entry;
    });
}

function checkQueryIsNumber(queryName, queryValue, response, min = -Infinity, max = Infinity) {
    var castedValue = Number(queryValue);

    if (Number.isNaN(castedValue)) {
        response.status(400);

        response.send({
            status: "error",
            code: "invalidQueryType",
            message: `The value for the query \`${queryName}\` is an invalid type. It must be a number.`
        });

        return false;
    }

    if (castedValue < min) {
        response.status(400);

        response.send({
            status: "error",
            code: "invalidQueryValue",
            message: `The value for the query \`${queryName}\` must be greater than or equal to ${min}.`
        });

        return false;
    }

    if (castedValue > max) {
        response.status(400);

        response.send({
            status: "error",
            code: "invalidQueryValue",
            message: `The value for the query \`${queryName}\` must be less than or equal to ${max}.`
        });

        return false;
    }

    return true;
}

function getKeywords(query) {
    return query.split(" ").map((keyword) => keyword.toLocaleLowerCase());
}

async function performSearchQuery(keywords, keywordWeighting = 0.5, referenceWeighting = 0.5, intersectionWeighting = 0.5, titleWeighting = 0.5) {
    var intersectionEntries = [];
    var unmatchedIndexes = await Promise.all(keywords.map((keyword) => indexes.getData(`${keyword}.tsv`)));
    var matchedIndexes = {};
    var deduplicatedKeywords = [...new Set(keywords)];
    var unindexedKeywords = [];
    var intersectionEntries = [];

    keywords.forEach(function(keyword, i) {
        var index = unmatchedIndexes[i];

        if (index == null) {
            unindexedKeywords.push(keyword);

            matchedIndexes[keyword] = [];

            return;
        }

        matchedIndexes[keyword] = tsvToObjects(index.toString());

        matchedIndexes[keyword].forEach(function(entry) {
            castObjectValues(entry, ["firstIndexed", "lastUpdated", "referenceScore", "keywordScore"], Number);

            var existingEntry = intersectionEntries.find((intersectionEntry) => intersectionEntry.url == entry.url);

            if (existingEntry) {
                existingEntry.keywordScore += entry.keywordScore;
                existingEntry.intersectionScore += Math.min(existingEntry.intersectionScore + (1 / 10), 1);
                existingEntry.intersectionTotal++;
            } else {
                entry.intersectionScore = 0.1;
                entry.intersectionTotal = 1;

                intersectionEntries.push(entry);
            }
        });
    });

    intersectionEntries.forEach(function(entry) {
        var queryKeywordsMatch = 0;
        var queryKeywordsNoMatch = 0;

        var keywordsLeft = [...keywords];

        entry.title.split(" ").forEach(function(titleKeyword) {
            titleKeyword = titleKeyword.toLocaleLowerCase();

            if (keywordsLeft.includes(titleKeyword)) {
                queryKeywordsMatch++;

                var keywordIndex = keywordsLeft.indexOf(titleKeyword);

                if (keywordIndex >= 0) {
                    keywordsLeft.splice(keywordIndex, 1);
                }
            } else {
                queryKeywordsNoMatch++;
            }
        });

        entry.titleScore = ((queryKeywordsMatch / keywords.length) + (1 - (queryKeywordsNoMatch / entry.title.split(" ").length))) / 2;
        entry.keywordScore /= entry.intersectionTotal;

        entry.weightedScore = (
            (entry.keywordScore * keywordWeighting) +
            (entry.referenceScore * referenceWeighting) +
            (entry.intersectionScore * intersectionWeighting) +
            (entry.titleScore * titleWeighting)
        );
    });

    return {
        results: intersectionEntries.sort((a, b) => b.weightedScore - a.weightedScore), // Sort by weighted score, descending order
        unindexedKeywords
    };
}

app.use(function(request, response, next) {
    response.header("Access-Control-Allow-Origin", "*");

    next();
});

app.get("/api/search", function(request, response) {
    if (request.query["query"]) {
        var query = request.query["query"];
        var weightings = {};
        var shouldExit = false;
        var queryShortened = false;
        var keywordsShortened = false;

        if (query.length > MAX_QUERY_LENGTH) {
            query = query.substring(0, MAX_QUERY_LENGTH);
            queryShortened = true;
        }

        var keywords = getKeywords(query);

        if (getKeywords(query).length > MAX_KEYWORDS_IN_QUERY) {
            keywords = keywords.slice(0, MAX_KEYWORDS_IN_QUERY);
            keywordsShortened = true;
        }

        ["keywordWeighting", "referenceWeighting", "intersectionWeighting", "titleWeighting"].forEach(function(weighting) {
            if (shouldExit) {
                return;
            }

            if (request.query[weighting]) {
                if (!checkQueryIsNumber(weighting, request.query[weighting], response, 0, 1)) {
                    shouldExit = true;
                }
    
                weightings[weighting] = Number(request.query[weighting]);
            }
        });

        if (shouldExit) {
            return;
        }

        performSearchQuery(
            keywords,
            weightings["keywordWeighting"],
            weightings["referenceWeighting"],
            weightings["intersectionWeighting"],
            weightings["titleWeighting"]
        ).then(function(data) {
            response.send({
                status: "ok",
                results: data.results,
                queryShortened,
                keywordsShortened,
                unindexedKeywords: data.unindexedKeywords
            });
        });

        return;
    }

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

console.log("Loading indexes...");

qlc.Collection.loadFromFile(path.join("data", "indexes.qlc")).then(function(collection) {
    indexes = collection;

    console.log("Loaded indexes");

    app.listen(process.argv[2], function() {
        console.log(`LiveG Search Service started on port ${process.argv[2]}`);
    });
});