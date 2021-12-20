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

let databaseInMemory = [
{
  instrument_reading_raw: 'xxxx', blockchainStatus: false, blockPayload: {proof: 0, previousBlockHash: 0}, instrument_serial_number: '3334', instrument_parsed: {
    lineeSplit_date: 'xxx', 
    lineeSplit_time: 'xx', 
    lineeSplit_measure: 0000, 
}  
}
  
  // {status: false, payload: [
  //   {
  //     name: 'Serial Number',
  //     value: '954833620976dhdsl'
  //   },
  //   {
  //     name: 'Date',
  //     value: '00/00/00'
  //     },
  //   {
  //     name: 'Time',
  //     value: 'HH:mm'
  //   },
  //   {
  //     name: 'Measure',
  //     value: '00000'
  //   },
  // ]
  // }  
]

app.post("/uploadDGD", async (req, res) => {
    console.log('contrust gateway uploadDGD: ',req.body)
    databaseInMemory.push(req.body)

    axios.post('http://localhost:5000/transaction', { 
      sender: databaseInMemory[databaseInMemory.length-1].instrument_serial_number+'___'+databaseInMemory.length, 
      receiver: 'contrust-'+databaseInMemory[databaseInMemory.length-1].instrument_serial_number+'___'+databaseInMemory.length , 
      amount: databaseInMemory[databaseInMemory.length-1].instrument_reading_raw})
  .then(res => {
      console.log(`statusCode: ${res.status}`)
      console.log(res.body)
  })
  .catch(error => {
      console.error(error)
  })   

    res.json({
      success: true,
      payload: databaseInMemory.length
    });
});


app.post("/updateChain", async (req, res) => {
    console.log('contrust gateway updateChain: ',req.body)
    databaseInMemory[req.body.blockChain[req.body.blockChain.length-1].index].blockchainStatus = true;
    databaseInMemory[req.body.blockChain[req.body.blockChain.length-1].index].blockPayload = req.body.blockChain[req.body.blockChain.length-1];
    res.json({success: true})

});

app.get("/getDB", async (req, res) => {
    console.log('contrust getDB: ',databaseInMemory)
    res.json({
      success: true,
      payload: databaseInMemory
    });

});

module.exports = {
    app,
    server,
  };
  