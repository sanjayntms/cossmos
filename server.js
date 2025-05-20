const express = require("express");
const { CosmosClient } = require("@azure/cosmos");
const cors = require("cors");
require("dotenv").config();
const path = require("path");

const app = express();
const port = 5000;

app.use(cors());
app.use(express.json());
app.use(express.static("public"));

const baseConfig = {
  endpoint: process.env.COSMOS_ENDPOINT,
  key: process.env.COSMOS_KEY,
  userAgentSuffix: "MovieAPI"
};

const databaseId = "MovieDB";
const containerId = "Movies";

const client = new CosmosClient(baseConfig);
const container = client.database(databaseId).container(containerId);

const preferredLocations = ['West US 3', 'Central India'];

function getClient(preferredRegion, consistencyLevel = "Eventual") {
  return new CosmosClient({
    ...baseConfig,
    consistencyLevel,
    connectionPolicy: {
      preferredLocations: [preferredRegion]
    }
  });
}

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/latency-report", async (req, res) => {
  const query = {
    query: "SELECT TOP 10 * FROM c ORDER BY c._ts DESC"
  };
  const consistency = req.query.consistency || "Session";

  const diagnostics = {};
  const debugResults = {};

  async function queryRegion(regionKey, regionName) {
    const result = { success: false, latency: null, error: null };
    try {
      const client = getClient(regionName, consistency);
      const start = Date.now();
      const response = await client
        .database(databaseId)
        .container(containerId)
        .items.query(query, { populateQueryMetrics: true })
        .fetchAll();
      const latency = Date.now() - start;

      const serviceEndpoint = response.headers?.["x-ms-serviceendpoint"] || "Unknown";

      const diagnosticData =
        response.diagnostics || response.headers?.["x-ms-documentdb-diagnostics"] || {};

      let endpoints = [];
      try {
        const diagObj =
          typeof diagnosticData === "string" ? JSON.parse(diagnosticData) : diagnosticData;
        endpoints = diagObj.clientSideRequestStatistics?.locationEndpointsContacted || [];
      } catch (err) {
        endpoints = [];
      }

      // Extract region served from endpoints URLs
      let regionServed = "Fallback";
      for (const ep of endpoints) {
        if (ep.includes("-centralindia")) {
          regionServed = "Central India";
          break;
        } else if (ep.includes("-westus3")) {
          regionServed = "West US 3";
          break;
        }
      }

      diagnostics[regionKey] = {
        raw: diagnosticData,
        endpoints,
        actualEndpoint: serviceEndpoint,
        regionServed
      };

      result.success = true;
      result.latency = latency;
      result.data = response.resources;
      result.regionServed = regionServed;
      result.endpoint = serviceEndpoint;
    } catch (err) {
      result.error = err.message;
      diagnostics[regionKey] = {
        raw: err.message,
        endpoints: [],
        actualEndpoint: "Error",
        regionServed: "Unavailable"
      };
    }
    debugResults[regionKey] = result;
  }

  await Promise.all([
    queryRegion("centralIndia", "Central India"),
    queryRegion("westUS3", "West US 3")
  ]);

  debugResults.diagnostics = diagnostics;
  debugResults.consistency = consistency;
  res.json(debugResults);
});

// POST endpoint to add movies with seed data from Web UI
app.post("/movies", async (req, res) => {
  try {
    const { title, genres, year, Rating, "Rotton Tomato": rottenTomato } = req.body;

    if (!title || !genres || !year) {
      return res.status(400).json({ message: "Missing required fields: title, genres, or year" });
    }

    // Create a unique id by sanitizing the title and appending the year
    const id = `${title.replace(/\s+/g, "-")}-${year}`;

    const movieDoc = {
      id,
      movie: id,
      genres,
      year,
      title,
      Rating,
      "Rotton Tomato": rottenTomato
    };

    await container.items.create(movieDoc);

    res.status(201).json(movieDoc);
  } catch (err) {
    console.error("Error adding movie:", err);
    res.status(500).json({ message: "Failed to add movie", error: err.message });
  }
});

app.listen(port, '0.0.0.0', () => {
  console.log(`Server running on http://0.0.0.0:${port}`);
});
