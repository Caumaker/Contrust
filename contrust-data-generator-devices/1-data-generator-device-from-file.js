const express = require('express');
const axios = require('axios');
const fs = require('fs');

const app = express();
const port = process.env.PORT || 8080;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));


app.post('/api/fileSource', function(req, res) {
    const fileSource = req.body.fileSource;

    var lines = fs.readFileSync(fileSource, 'utf-8')
    .split('\n')
    .filter(Boolean);
  
    for(let x = 0; x < lines.length; x++){
        setTimeout(()=>{
            // axios.post('https://contrust.com/54335743986731', { instrument_reading: lines[x]})
            axios.post('http://localhost:6001/uploadDGD', { instrument_reading: lines[x]})
            .then(res => {
                console.log(`statusCode: ${res.status}`)
                console.log(res)
            })
            .catch(error => {
                console.error(error)
            })    
        },x*10000)
    }
  });
  
  app.listen(port);
  console.log('Contrust DGD server started at http://localhost:' + port);