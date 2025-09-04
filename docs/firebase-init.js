// No imports here — we use the compat CDN scripts included in admin.html
// (firebase-app-compat.js and firebase-auth-compat.js)

const firebaseConfig = {
  apiKey: "AIzaSyDPD5Isrb2VpFDIA_2d_Hc6vc4SlaRGw58",
  authDomain: "attendance-app-820b0.firebaseapp.com",
  projectId: "attendance-app-820b0",
  storageBucket: "attendance-app-820b0.firebasestorage.app",
  messagingSenderId: "195821555404",
  appId: "1:195821555404:web:2c2009a38bf42a88f53c69"
};

firebase.initializeApp(firebaseConfig);
window.firebaseAuth = firebase.auth(); // used by admin.js
