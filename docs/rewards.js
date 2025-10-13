// Show/hide UI based on auth state
const onlyAuthed = document.getElementById("onlyAuthed");

function showAuthedUI(user) {
  onlyAuthed.style.display = "block";
}

function showSignedOutUI() {
  onlyAuthed.style.display = "none";
  document.body.innerHTML = `
    <div style="color:#fff; background:#b00020; padding:2rem; border-radius:1rem; margin:2rem auto; max-width:400px; text-align:center;">
      <h2>Not signed in</h2>
      <p>Please <a href="teacher.html" style="color:#e7f802;">sign in</a> to view rewards.</p>
    </div>
  `;
}

// Wait for Firebase to be ready, then check auth state
(async function init() {
  await (window.firebaseReady || Promise.resolve());
  const auth = window.firebaseAuth || firebase.auth();

  auth.onAuthStateChanged(user => {
    if (user) {
      showAuthedUI(user);
    } else {
      showSignedOutUI();
    }
      });
})();