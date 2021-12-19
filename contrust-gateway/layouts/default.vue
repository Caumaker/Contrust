<template>
  <v-app dark>
    <v-navigation-drawer
      v-model="drawer"
      :mini-variant="miniVariant"
      :clipped="clipped"
      fixed
      app
    >
      <v-list>
        <v-list-item
          v-for="(item, i) in items"
          :key="i"
          :to="item.to"
          router
          exact
        >
          <v-list-item-action>
            <v-icon>{{ item.icon }}</v-icon>
          </v-list-item-action>
          <v-list-item-content >
            <v-list-item-title v-text="item.title" />
               </v-list-item-content>
        </v-list-item>
      </v-list>
    </v-navigation-drawer>
    <v-app-bar
      :clipped-left="clipped"
      fixed
      app
    >
    <a target = "_blank" href="https://github.com/Caumaker/Contrust">
      <img style="position: absolute; top: 0px; right: 0px; width: 140px !important; cursor: pointer !important;"  :src="img" />
  </a>
      <v-toolbar-title class="ml-3" style="font-family: 'Jura', sans-serif; font-weight: 800 !important; font-size: 1.4em; cursor: pointer !important" v-text="title" />
      <v-list class="mt-2 transparent">
        <v-list-item
        >
          <v-list-item-content >
            <!-- <v-list-item-title v-text="title" /> -->
            <v-list-item-subtitle>Digital Construction Enhanced by Blockchain</v-list-item-subtitle>
          </v-list-item-content>
        </v-list-item>
      </v-list>
     
      <v-spacer />
    </v-app-bar>
    <v-main>
      <v-container>
        <Nuxt />
      </v-container>
    </v-main>
    <v-navigation-drawer
      v-model="rightDrawer"
      :right="right"
      temporary
      fixed
    >
      <v-list>
        <v-list-item @click.native="right = !right">
          <v-list-item-action>
            <v-icon light>
              mdi-repeat
            </v-icon>
          </v-list-item-action>
          <v-list-item-title>Switch drawer (click me)</v-list-item-title>
        </v-list-item>
      </v-list>
    </v-navigation-drawer>
    <v-footer
      :absolute="!fixed"
      app
    >
      <span style="color: grey; font-size: 0.9em;">{{ new Date().getFullYear() }} - Contrust is a Open Source solution for Digital Construction Auditability.</span>
    </v-footer>
  </v-app>
</template>

<script>
export default {
  data () {
    return {
      clipped: true,
      drawer: true,
      img:  require('@/assets/fork-me-on-github-ribbon.png'),
      fixed: false,
      items: [
        {
          icon: 'mdi-apps',
          title: 'Dashbaord',
          to: '/'
        },
        {
          icon: 'mdi-chart-bubble',
          title: 'Project Information',
          to: '/details'
        },
        {
          icon: 'mdi-sitemap-outline',
          title: 'Instrument Blockchain',
          to: '/blockchain'
        },
        {
          icon: 'mdi-lifebuoy',
          title: 'Help',
          to: '/help'
        }
      ],
      miniVariant: false,
      right: false,
      rightDrawer: false,
      title: 'CONTRUST'
    }
  }
}
</script>
