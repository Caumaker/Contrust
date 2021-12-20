<template>
  <v-row justify="center" align="center">
    <v-col cols="12" >
      <v-card>
        <v-card-title class="headline">
          Welcome to the CONTRUST
        </v-card-title>
        <v-card-text>
          <p class="title">Contrust is a digital construction auditablity tool enhanced by blockchain. It was designed to empower engineering companies in the process of digital transformation.</p>
          <hr class="my-3">
          <a
            href="https://construst.com/documentation"
            target="_blank"
            rel="noopener noreferrer"
          >
            Construst Documentation
          </a>
          <br>
          <a
            href="https://github.com/Caumaker/Contrust"
            target="_blank"
            rel="noopener noreferrer"
          >
            Construst on GitHub
          </a>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn
            color="primary"
            nuxt
            @click="getDB"
          >
            Start now!
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-col>
  </v-row>
</template>
<script>
  export default {
    data: () => ({
      dialog: false,
    }),
     methods: {
        async getDB() {
            let getDB = await this.$axios.$get('/getDB')
            console.log('getDB: ',getDB)
        }
      }
  }
</script>