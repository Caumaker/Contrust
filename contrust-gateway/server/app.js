const app = require('express')();
const express = require('express');
const server = require('http').createServer(app);
const path = require("path");
const fs = require("fs");
const bodyParser = require("body-parser");
const cors = require("cors");
const axios = require("axios");
const { performance } = require('perf_hooks');

var corsOptions = {
  origin: "*",
  credentials: true,
  optionSuccessStatus: 200,
};
app.use(cors(corsOptions));

app.use(bodyParser.json({ limit: "50mb", extended: true }));
app.use(bodyParser.urlencoded({ limit: "50mb", extended: true }));

app.use(express.json());

app.post("/hi", async (req, res) => {
    console.log('HI from server')
});

module.exports = {
    app,
    server,
  };
  