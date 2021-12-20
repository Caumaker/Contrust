<template>
  <v-row align="center">
    <v-col cols="12" >
      <v-card>
        <v-card-title class="subtitle">
          <span>
          Construst Data Blockchain for Instrument: 
          </span>
          <span class="ml-2" style="color: orange">
        954833620976dhdsl
          </span>
        </v-card-title>
        <v-card-actions>
          <v-btn
            color="primary"
            nuxt
            @click="getDB"
          >
            {{(dialog===null)?'Update':'Stop'}}
          </v-btn>
        </v-card-actions>
        <hr />
      </v-card>
        </v-col>
        <template v-for="(item, index) in blocks">
          <v-col :key="'index'+index" v-if="index>0" cols="12" md="3">
        <v-card :style="{'background-color': (item.status===false)?'#37474F':''}" class="pa-2 ">
        <v-container class="pa-0 ma-0">
        <v-row class="pa-0 ma-0">
          <v-col cols="12">
          <span class="mt-2">
            Block index: {{index}}
          </span><br>
          <span class="mt-2 caption">
            Proof: {{item.blockPayloadProof}}
            <!-- Proof: {{(item.blockPayloadProof!=='')?item.blockPayloadProof:}} -->
   <v-progress-circular
      :width="2"
      color="red"
      v-if="item.blockPayloadProof===''"
      indeterminate
    ></v-progress-circular>            
            <!-- <img v-if="item.blockPayloadProof===''" style="width: 20px !important; cursor: none !important;"  :src="loading" /> -->
          </span><br>
          <span class="caption mt-2">
            Hash: 
          </span>
          <span class="caption mt-2" style="font-size: 0.6em !important;">
            {{item.blockPayloadHash}}
   <v-progress-circular
      :width="2"
      color="red"
      v-if="item.blockPayloadHash===''"
      indeterminate
    ></v-progress-circular>
    <br v-if="item.blockPayloadHash===''" />
    <br v-if="item.blockPayloadHash===''" />
            <!-- Hash: {{(item.blockPayloadHash!=='')?item.blockPayloadHash:<img style="width: 40px !important; cursor: none !important;"  :src="loading" />}} -->
            <!-- <img v-if="item.blockPayloadHash===''" style="width: 20px !important; cursor: none !important;"  :src="loading" /> -->
          </span>
        <v-divider class="my-1" />
          </v-col>
        </v-row>
        <v-row class="pa-0 ma-0">
  <v-simple-table style="width: 100% !important;" class="fluid" dense>
    <template v-slot:default>
      <thead style="width: 100% !important;">
        <tr style="width: 100% !important;">
          <th class="text-left">
            Name
          </th>
          <th class="text-left">
            Value
          </th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="item in item.payload"
          :key="item.name"
        >
          <td>{{ item.name }}</td>
          <td>{{ item.value }}</td>
        </tr>
      </tbody>
    </template>
  </v-simple-table>

        <!-- <template v-for="(itemx, indexx) in item"> -->
          <!-- <v-col cols="12" :key="'index-row'+indexx" class="pa-0 px-2 ma-0"> -->
          <!-- <v-col cols="12"  class="pa-0 px-2 ma-0">
          <span class="mt-1">
            Date: {{item.date}}
          </span>
          </v-col>
          <v-col cols="12"  class="pa-0 px-2 ma-0">
          <span class="mt-1">
            Time: {{item.time}}
          </span>
          </v-col>
          <v-col cols="12"  class="pa-0 px-2 ma-0">
          <span class="mt-1">
            Measure: {{item.measure}}
          </span>
          </v-col> -->
        <!-- </template> -->
        </v-row>
        </v-container>
      </v-card>
        </v-col>
        </template>


  </v-row>
</template>
<script>
  export default {
    data: () => ({
      dialog: null,
       loading:  require('@/assets/loading.gif'),
      blocks: []
    }),
     methods: {
        async getDB() {
          if(this.dialog !== null){
            clearInterval(this.dialog);
            this.dialog = null
          }else{
            this.dialog = setInterval(async ()=>{
              let getDB = await this.$axios.$get('/getDB')
              if(getDB.payload.length > 0){
                this.blocks = []
                if(getDB.payload.length===0){
                  return
                }
                getDB.payload.forEach((item,index)=>{

                  this.blocks.push(
                    {
                      status: item.blockchainStatus, 
                      blockPayloadProof: item.blockPayload.proof, 
                      blockPayloadHash: item.blockPayload.previousBlockHash, 
                    payload: [
                    {
                      name: 'Serial Number',
                      value: item.instrument_serial_number
                    },
                    {
                      name: 'Date',
                      value: item.instrument_parsed.lineeSplit_date
                      },
                    {
                      name: 'Time',
                      value: item.instrument_parsed.lineeSplit_time
                    },
                    {
                      name: 'Measure',
                      value: item.instrument_parsed.lineeSplit_measure
                    },
                  ]
                  })
                })
              } 
              console.log('getDB: ',getDB)            
            },5000)
          }
        }
      }
  }
</script>