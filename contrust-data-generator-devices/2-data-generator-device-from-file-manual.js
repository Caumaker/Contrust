const axios = require('axios');
const fs = require('fs');

//data source in windows
const fileSource = "C:\\Users\\Somensi\\Documents\\_meusapps\\2022\\Contrust\\contrust-data-generator-devices\\dataSource.txt";
const instrument_serial_number = "954833620976dhdsl"

// read and split lines
var lines = fs.readFileSync(fileSource, 'utf-8')
.split('\n')
.filter(Boolean);


// =========== debug data from split =================================================
// let lineeSplit_date = lines[0].split(" ")[0];
// let lineeSplit_time = lines[0].split(" ")[1].split("\t")[0];
// let lineeSplit_measure = lines[0].split(" ")[1].split("\t")[1].replaceAll(",", ".");

// console.log('lineeSplit_date: ',lineeSplit_date)
// console.log('lineeSplit_time: ',lineeSplit_time)
// console.log('lineeSplit_measure: ',lineeSplit_measure*1)
// ==================================================================================

// for(let x = 0; x < 5; x++){
    for(let x = 0; x < lines.length; x++){
        setTimeout(()=>{
            
            let lineeSplit_date = lines[x].split(" ")[0];
            let lineeSplit_time = lines[x].split(" ")[1].split("\t")[0];
            let lineeSplit_measure = lines[x].split(" ")[1].split("\t")[1].replaceAll(",", ".");
            console.log('DGD posting: '+'lineeSplit_date: ',lineeSplit_date + ' | lineeSplit_time: ',lineeSplit_time + ' | lineeSplit_measure: ',lineeSplit_measure*1);

        axios.post('http://localhost:6001/uploadDGD', { 
            instrument_reading_raw: lines[x], blockchainStatus: false, blockPayload: {proof: '', previousBlockHash: ''},instrument_serial_number: instrument_serial_number, instrument_parsed: {
                lineeSplit_date: lineeSplit_date, 
                lineeSplit_time: lineeSplit_time, 
                lineeSplit_measure: lineeSplit_measure, 
            }
        })
        .then(res => {
            console.log(`statusCode: ${res.status}`)
            // console.log(res)
        })
        .catch(error => {
            console.error(error)
        })    
    },x*10000)
}
