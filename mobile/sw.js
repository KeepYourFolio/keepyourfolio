/* Keep Your Folio Mobile 1.19 : fonctionnement hors ligne.
   Ne met en cache que les fichiers de cette appli (même adresse). Les téléchargements vers
   d’autres sites (base publique) et tout le reste ne passent jamais par ce cache. */
var CACHE="kyfm-3.73.0";
var FICHIERS=["./","index.html","manifest.webmanifest","icon-192.png","icon-512.png","icon-512-maskable.png","apple-touch-icon.png","icon-dark-192.png","icon-mono-512.png","jsqr.js","avf.js","qr.js","countries.json"].concat(["logos/aave.png","logos/ada.png","logos/algo.png","logos/atom.png","logos/avax.png","logos/bch.png","logos/bnb.png","logos/btc.png","logos/dai.png","logos/dash.png","logos/doge.png","logos/dot.png","logos/etc.png","logos/eth.png","logos/fil.png","logos/icp.png","logos/leo.png","logos/link.png","logos/ltc.png","logos/paxg.png","logos/sol.png","logos/trx.png","logos/uni.png","logos/usdc.png","logos/usdt.png","logos/vet.png","logos/wbtc.png","logos/xlm.png","logos/xmr.png","logos/xrp.png","logos/zec.png"]);
self.addEventListener("install",function(e){e.waitUntil(caches.open(CACHE).then(function(c){return c.addAll(FICHIERS)}).then(function(){return self.skipWaiting()}))});
self.addEventListener("activate",function(e){e.waitUntil(caches.keys().then(function(ks){return Promise.all(ks.filter(function(k){return k!==CACHE&&k!=="kyfm-lourd"}).map(function(k){return caches.delete(k)}))}).then(function(){return self.clients.claim()}))});
/* Partage entrant (Android) : le texte et les images partagés restent en mémoire du service worker, jamais dans un cache,
   jamais dans un journal, jamais envoyé au réseau. La page le réclame une seule fois, puis il est effacé. */
var ATTENTE=null,DUREE_MAX=120000;
self.addEventListener("message",function(e){
  if(!e.data||e.data.type!=="RECLAMER_PARTAGE"||!e.ports||!e.ports[0])return;
  var p=ATTENTE;ATTENTE=null;
  if(p&&Date.now()-p.t>DUREE_MAX)p=null;
  e.ports[0].postMessage(p?{ok:true,title:p.title,text:p.text,files:p.files}:{ok:false})});
self.addEventListener("fetch",function(e){
  var r=e.request,u=new URL(r.url);
  if(r.method==="POST"&&u.origin===self.location.origin&&/\/partage-recu$/.test(u.pathname)){
    var sf=(r.headers.get("sec-fetch-site")||"").toLowerCase(),og=r.headers.get("origin");
    if(sf==="cross-site"||(og&&og!=="null"&&og!==self.location.origin)){e.respondWith(Response.redirect(new URL("./",self.registration.scope).href,303));return}
    e.respondWith((async function(){
      try{var fd=await r.formData();ATTENTE={t:Date.now(),title:String(fd.get("title")||""),text:String(fd.get("text")||""),files:fd.getAll("images").filter(function(f){return f&&typeof f==="object"&&f.size>0&&/^image\//.test(f.type||"")}).slice(0,3)}}
      catch(err){ATTENTE=null}
      return Response.redirect(new URL("./?partage=1",self.registration.scope).href,303)})());
    return}
  if(r.method!=="GET"||u.origin!==self.location.origin)return;
  if(/\/(ocr\/|pdf\/|kyf-pdf\.js$)/.test(u.pathname)){e.respondWith(caches.open("kyfm-lourd").then(function(c){return c.match(r).then(function(h){return (r.cache!=="reload"&&h)||fetch(r).then(function(rep){if(rep&&rep.ok)c.put(r,rep.clone());return rep})})}));return}
  if(u.search.indexOf("partage=")>-1){e.respondWith(fetch(r).catch(function(){return caches.match("index.html")}));return}
  e.respondWith(fetch(r,(r.mode==="navigate"||/\/(index\.html|sw\.js)?$/.test(u.pathname))?{cache:"no-store"}:undefined).then(function(rep){
    if(rep&&rep.ok){var copie=rep.clone();caches.open(CACHE).then(function(c){c.put(r,copie)})}
    return rep
  }).catch(function(){return caches.match(r).then(function(m){return m||caches.match("index.html")})}));
});
