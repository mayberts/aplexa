'use strict';

const Alexa = require('ask-sdk-core');
const { FilePersistenceAdapter } = require('./filePersistenceAdapter');
const plex = require('./plex');

const persistenceAdapter = new FilePersistenceAdapter();

function streamToken(track, index) {
  return `${track.ratingKey}#${index}`;
}

async function loadState(handlerInput) {
  const attrs = await handlerInput.attributesManager.getPersistentAttributes();
  return {
    queue: attrs.queue || [],
    index: attrs.index || 0,
    offsetMs: attrs.offsetMs || 0,
    loop: !!attrs.loop,
    shuffle: !!attrs.shuffle
  };
}

async function saveState(handlerInput, state) {
  handlerInput.attributesManager.setPersistentAttributes(state);
  await handlerInput.attributesManager.savePersistentAttributes();
}

function shuffleArray(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function playDirective(track, index, offsetMs, behavior) {
  return {
    type: 'AudioPlayer.Play',
    playBehavior: behavior || 'REPLACE_ALL',
    audioItem: {
      stream: {
        token: streamToken(track, index),
        url: track.streamUrl,
        offsetInMilliseconds: offsetMs || 0
      },
      metadata: {
        title: track.title,
        subtitle: track.artist,
        art: track.thumb ? { sources: [{ url: track.thumb }] } : undefined
      }
    }
  };
}

const LaunchRequestHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'LaunchRequest';
  },
  handle(handlerInput) {
    return handlerInput.responseBuilder
      .speak('Welcome to Plex. Say play, followed by a song, artist, album, or playlist.')
      .reprompt('What would you like to play?')
      .getResponse();
  }
};

const PlayMusicIntentHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest'
      && Alexa.getIntentName(handlerInput.requestEnvelope) === 'PlayMusicIntent';
  },
  async handle(handlerInput) {
    const query = Alexa.getSlotValue(handlerInput.requestEnvelope, 'SearchQuery');
    if (!query) {
      return handlerInput.responseBuilder
        .speak("I didn't catch what to play. Try again, like, play Thriller.")
        .reprompt('What would you like to play?')
        .getResponse();
    }

    let queue;
    try {
      queue = await plex.resolveQueue(query);
    } catch (err) {
      console.error('Plex search failed', err);
      return handlerInput.responseBuilder
        .speak("I couldn't reach your Plex server. Please check it's online and try again.")
        .getResponse();
    }

    if (!queue.length) {
      return handlerInput.responseBuilder
        .speak(`I couldn't find anything matching ${query} in Plex.`)
        .getResponse();
    }

    const state = { queue, index: 0, offsetMs: 0, loop: false, shuffle: false };
    await saveState(handlerInput, state);

    const track = queue[0];
    return handlerInput.responseBuilder
      .speak(`Playing ${track.title} by ${track.artist}.`)
      .addDirective(playDirective(track, 0, 0))
      .withShouldEndSession(true)
      .getResponse();
  }
};

const PauseIntentHandler = {
  canHandle(handlerInput) {
    const type = Alexa.getRequestType(handlerInput.requestEnvelope);
    return (type === 'IntentRequest'
      && ['AMAZON.PauseIntent', 'AMAZON.StopIntent', 'AMAZON.CancelIntent'].includes(Alexa.getIntentName(handlerInput.requestEnvelope)))
      || type === 'PlaybackController.PauseCommandIssued';
  },
  handle(handlerInput) {
    return handlerInput.responseBuilder
      .addDirective({ type: 'AudioPlayer.Stop' })
      .getResponse();
  }
};

const ResumeIntentHandler = {
  canHandle(handlerInput) {
    const type = Alexa.getRequestType(handlerInput.requestEnvelope);
    return (type === 'IntentRequest' && Alexa.getIntentName(handlerInput.requestEnvelope) === 'AMAZON.ResumeIntent')
      || type === 'PlaybackController.PlayCommandIssued';
  },
  async handle(handlerInput) {
    const state = await loadState(handlerInput);
    if (!state.queue.length) {
      return handlerInput.responseBuilder.speak('There is nothing to resume.').getResponse();
    }
    const track = state.queue[state.index];
    return handlerInput.responseBuilder
      .addDirective(playDirective(track, state.index, state.offsetMs))
      .getResponse();
  }
};

async function advance(handlerInput, direction) {
  const state = await loadState(handlerInput);
  if (!state.queue.length) {
    return handlerInput.responseBuilder.speak('There is nothing playing.').getResponse();
  }
  let nextIndex = state.index + direction;
  if (nextIndex < 0) {
    nextIndex = state.loop ? state.queue.length - 1 : 0;
  } else if (nextIndex >= state.queue.length) {
    if (state.loop) {
      nextIndex = 0;
    } else {
      state.index = state.queue.length - 1;
      await saveState(handlerInput, state);
      return handlerInput.responseBuilder
        .addDirective({ type: 'AudioPlayer.Stop' })
        .speak("That's the end of the queue.")
        .getResponse();
    }
  }
  state.index = nextIndex;
  state.offsetMs = 0;
  await saveState(handlerInput, state);
  const track = state.queue[nextIndex];
  return handlerInput.responseBuilder
    .addDirective(playDirective(track, nextIndex, 0))
    .getResponse();
}

const NextIntentHandler = {
  canHandle(handlerInput) {
    const type = Alexa.getRequestType(handlerInput.requestEnvelope);
    return (type === 'IntentRequest' && Alexa.getIntentName(handlerInput.requestEnvelope) === 'AMAZON.NextIntent')
      || type === 'PlaybackController.NextCommandIssued';
  },
  handle(handlerInput) {
    return advance(handlerInput, 1);
  }
};

const PreviousIntentHandler = {
  canHandle(handlerInput) {
    const type = Alexa.getRequestType(handlerInput.requestEnvelope);
    return (type === 'IntentRequest' && Alexa.getIntentName(handlerInput.requestEnvelope) === 'AMAZON.PreviousIntent')
      || type === 'PlaybackController.PreviousCommandIssued';
  },
  handle(handlerInput) {
    return advance(handlerInput, -1);
  }
};

const LoopOnOffHandler = {
  canHandle(handlerInput) {
    const type = Alexa.getRequestType(handlerInput.requestEnvelope);
    return type === 'IntentRequest'
      && ['AMAZON.LoopOnIntent', 'AMAZON.LoopOffIntent'].includes(Alexa.getIntentName(handlerInput.requestEnvelope));
  },
  async handle(handlerInput) {
    const on = Alexa.getIntentName(handlerInput.requestEnvelope) === 'AMAZON.LoopOnIntent';
    const state = await loadState(handlerInput);
    state.loop = on;
    await saveState(handlerInput, state);
    return handlerInput.responseBuilder.speak(on ? 'Looping the queue.' : 'Loop off.').getResponse();
  }
};

const ShuffleOnOffHandler = {
  canHandle(handlerInput) {
    const type = Alexa.getRequestType(handlerInput.requestEnvelope);
    return type === 'IntentRequest'
      && ['AMAZON.ShuffleOnIntent', 'AMAZON.ShuffleOffIntent'].includes(Alexa.getIntentName(handlerInput.requestEnvelope));
  },
  async handle(handlerInput) {
    const on = Alexa.getIntentName(handlerInput.requestEnvelope) === 'AMAZON.ShuffleOnIntent';
    const state = await loadState(handlerInput);
    if (on && state.queue.length) {
      const current = state.queue[state.index];
      const rest = state.queue.filter((_, i) => i !== state.index);
      state.queue = [current, ...shuffleArray(rest)];
      state.index = 0;
    }
    state.shuffle = on;
    await saveState(handlerInput, state);
    return handlerInput.responseBuilder.speak(on ? 'Shuffling.' : 'Shuffle off.').getResponse();
  }
};

const WhatsPlayingIntentHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest'
      && Alexa.getIntentName(handlerInput.requestEnvelope) === 'WhatsPlayingIntent';
  },
  async handle(handlerInput) {
    const state = await loadState(handlerInput);
    if (!state.queue.length) {
      return handlerInput.responseBuilder.speak('Nothing is playing.').getResponse();
    }
    const track = state.queue[state.index];
    return handlerInput.responseBuilder.speak(`This is ${track.title} by ${track.artist}.`).getResponse();
  }
};

const PlaybackStoppedHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'AudioPlayer.PlaybackStopped';
  },
  async handle(handlerInput) {
    const { offsetInMilliseconds } = handlerInput.requestEnvelope.request;
    const state = await loadState(handlerInput);
    state.offsetMs = offsetInMilliseconds || 0;
    await saveState(handlerInput, state);
    return handlerInput.responseBuilder.getResponse();
  }
};

const PlaybackNearlyFinishedHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'AudioPlayer.PlaybackNearlyFinished';
  },
  async handle(handlerInput) {
    const state = await loadState(handlerInput);
    if (!state.queue.length) return handlerInput.responseBuilder.getResponse();
    let nextIndex = state.index + 1;
    if (nextIndex >= state.queue.length) {
      if (!state.loop) return handlerInput.responseBuilder.getResponse();
      nextIndex = 0;
    }
    const track = state.queue[nextIndex];
    return handlerInput.responseBuilder
      .addDirective(playDirective(track, nextIndex, 0, 'ENQUEUE'))
      .getResponse();
  }
};

const PlaybackFinishedHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'AudioPlayer.PlaybackFinished';
  },
  async handle(handlerInput) {
    const state = await loadState(handlerInput);
    if (!state.queue.length) return handlerInput.responseBuilder.getResponse();
    let nextIndex = state.index + 1;
    if (nextIndex >= state.queue.length) {
      nextIndex = state.loop ? 0 : state.index;
    }
    state.index = nextIndex;
    state.offsetMs = 0;
    await saveState(handlerInput, state);
    return handlerInput.responseBuilder.getResponse();
  }
};

const PlaybackFailedHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'AudioPlayer.PlaybackFailed';
  },
  handle(handlerInput) {
    console.error('Playback failed', JSON.stringify(handlerInput.requestEnvelope.request));
    return handlerInput.responseBuilder.getResponse();
  }
};

const HelpIntentHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest'
      && Alexa.getIntentName(handlerInput.requestEnvelope) === 'AMAZON.HelpIntent';
  },
  handle(handlerInput) {
    return handlerInput.responseBuilder
      .speak('Say play, followed by a song, artist, album, or playlist from your Plex library. You can also say pause, resume, next, previous, shuffle, or loop.')
      .reprompt('What would you like to play?')
      .getResponse();
  }
};

const SessionEndedRequestHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'SessionEndedRequest';
  },
  handle(handlerInput) {
    return handlerInput.responseBuilder.getResponse();
  }
};

const ErrorHandler = {
  canHandle() {
    return true;
  },
  handle(handlerInput, error) {
    console.error('Unhandled error', error);
    return handlerInput.responseBuilder
      .speak('Sorry, something went wrong talking to Plex.')
      .getResponse();
  }
};

const skill = Alexa.SkillBuilders.custom()
  .withPersistenceAdapter(persistenceAdapter)
  .addRequestHandlers(
    LaunchRequestHandler,
    PlayMusicIntentHandler,
    PauseIntentHandler,
    ResumeIntentHandler,
    NextIntentHandler,
    PreviousIntentHandler,
    LoopOnOffHandler,
    ShuffleOnOffHandler,
    WhatsPlayingIntentHandler,
    PlaybackStoppedHandler,
    PlaybackNearlyFinishedHandler,
    PlaybackFinishedHandler,
    PlaybackFailedHandler,
    HelpIntentHandler,
    SessionEndedRequestHandler
  )
  .addErrorHandlers(ErrorHandler)
  .create();

module.exports = { skill };
