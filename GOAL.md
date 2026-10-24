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

## Then: one assistant, simply

In this repo we want it to:

* be able to hear
* use a model
* only 1, not 3. only 1 model
* call any tool it needs from https://github.com/ainigh/tool-mac-tool-run
* use that tool to manage the library, so no library like the other super voice has
* combine the prompt in a way that it uses the 'intelligence' of the 3 that Super Voice had (Tom,
  Jerry, Jane), like at certain times etc
* clicking on the character should toggle show/hide the chat interface; the interface contains
  buttons to cycle through character size
* the chat interface should list all available tools, obtained via the API when the character loads
* unlike Super Voice, when the character loads, it should be on standby to take any instruction
* selecting an avatar is selecting a voice
* add 2 more avatars, male and female, distinct
* let the model schedule a time x minutes from now, or a specific date/time; then the system shows
  the avatar and calls the model at that time (if it's not already shown). Multiple at once, and
  cancelling. Likely the only tool that's in this system and not over the API
* craft the prompts well, such that the model can learn
* when it calls the API for tool use, it should be able to cancel it

Basically this is just a chat with access to tools. Not the typical Ollama tools: hand-rolled, like
in Super Voice.
