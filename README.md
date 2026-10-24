# JUST-super-mac-tts-ONLY-service


We want to extract the tts from https://github.com/ainigh/super-mac-tts-stt-service/tree/main into this repo, so the tts is on its own and has api that https://github.com/ainigh/super-mac-tts-stt-service/tree/main calls when it needs to speak

https://github.com/ainigh/super-mac-tts-stt-service/tree/main remains the ears, while this repo becomes the mouth and presentation 


https://github.com/ainigh/super-mac-tts-stt-service/tree/main already runs well, we just want to separate the concerns

for https://github.com/ainigh/super-mac-tts-stt-service/tree/main , we hope to find a way it doesnt hear itself. the thing is that if model hears itself, we know because we can compare without doing any fancy complicated stuff. 

the app this repo provides uses animated 3d from https://github.com/met4citizen/TalkingHead , https://github.com/met4citizen/HeadTTS with full emotion

we want to provide api for cliebts, smilar way as https://github.com/ainigh/super-mac-tts-stt-service/tree/main does. it should support update etc

Also for any model work, it needs the  https://github.com/ainigh/super-mac-tts-stt-service/tree/main  so the api should dictate that. if we can use 1 model instead of 2, lets do so. note that the model accees is on  https://github.com/ainigh/super-mac-tts-stt-service/tree/main  and not in this app we want to build.


what is this app to buikld in thids repo?

a 3d with no background that shows up in full head to toes and is the face of whatever the cleint provides, its the expression, like speech to expression . this app does tts and to expression , utilizing the full range possible from the library

there is an exaple implementation in the repo. take only as rough idea. re-implement the mac app, have icon in menu, click or client call aoi should make it show up. 

we want to update the  https://github.com/ainigh/super-mac-tts-stt-service/tree/main  as well accordingly
