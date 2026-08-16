Focus Mode's ambient sounds are no longer files.

rain and forest are generated at runtime in buam-fx.js with Web Audio
(pink noise shaped by filters, plus scheduled bird calls for forest), so
there is nothing to download, nothing to license, and the loop has no seam.

This directory is kept only so existing links to it do not 404. Dropping
rain.mp3 / forest.mp3 in here has no effect — see buildRain / buildForest
in buam-fx.js to change how they sound.
