# JUST-super-mac-tts-ONLY-service


We want to extract the tts from https://github.com/ainigh/super-mac-tts-stt-service/tree/main into this repo, so the tts is on its own and has api that https://github.com/ainigh/super-mac-tts-stt-service/tree/main calls when it needs to speak

https://github.com/ainigh/super-mac-tts-stt-service/tree/main remains the ears, while this repo becomes the mouth and presentation 


https://github.com/ainigh/super-mac-tts-stt-service/tree/main already runs well, we just want to separate the concerns

for https://github.com/ainigh/super-mac-tts-stt-service/tree/main , we hope to find a way it doesnt hear itself. the thing is that if model hears itself, we know because we can compare without doing any fancy complicated stuff. 

the app this repo provides uses animated 3d from https://github.com/met4citizen/HeadTTS with full emotion

we want to provide api for cliebts, smilar way as https://github.com/ainigh/super-mac-tts-stt-service/tree/main does. it should support update etc

