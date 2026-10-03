// Loaded inside the in-app "Terms & Privacy" modal (an iframe) -- that modal already has
// its own close button, so this page's own header/back-link would be a second, confusing
// way to leave a tiny embedded frame. Hidden via a class instead of not rendering it, so a
// direct visit to this page (not embedded) still gets the header.
if (window.self !== window.top) document.documentElement.classList.add('embedded');
