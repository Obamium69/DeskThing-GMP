import * as dbus from "dbus-next";
import * as dbusnative from "dbus-native";
import sharp from "sharp";

type SongData = {
  id: string;
  album: string;
  artist: string;
  track_name: string;
  thumbnail: string;
  is_playing: boolean;
  volume: number;
  shuffle_state: string;
  repeat_state: string;
  track_progress: number;
  track_length: number;
  can_play: boolean;
  can_change_volume: boolean;
  playlist: string;
};

class linuxPlayer {
  private DeskThing: any;
  private player: any;
  private playerObject: any;
  private playerObjectProperties: any;
  private sessionBus: any;
  private serviceName: any;
  private serviceNameBus: any;
  private isUpdating: boolean;
  private updateTimeout: number;
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
  private currentId: string;

  constructor(DeskThing: any) {
    this.DeskThing = DeskThing;
    this.player = null;
    this.serviceName = null;
    this.serviceNameBus = null;
    this.playerObject = null;
    this.playerObjectProperties = null;
    this.sessionBus = dbus.sessionBus();
    this.serviceNameBus = dbusnative.sessionBus();
    this.currentId = "";
    this.isUpdating = false;
    this.updateTimeout = 1500;
  }

  setUpdate() {
    if (!this.isUpdating) {
      this.isUpdating = true;
      setTimeout(() => {
        this.isUpdating = false;
      }, this.updateTimeout);
    } else return false;
  }

  async detectMediaPlayer() {
    const mediaPlayerPrefixes = [
      "org.mpris.MediaPlayer2.spotify",
      "org.mpris.MediaPlayer2.firefox.instance_",
      "org.mpris.MediaPlayer2.chromium.instance_",
      "org.mpris.MediaPlayer2.google-chrome.instance_",
    ];

    const names: string[] = await new Promise((resolve, reject) => {
      this.serviceNameBus.listNames((err: any, results: any) => {
        if (err) {
          reject(err);
        } else {
          resolve(results);
        }
      });
    });

    for (const prefix of mediaPlayerPrefixes) {
      const playerName = names.find((name: string) => name.startsWith(prefix));
      if (playerName) {
        console.log("Found media player:", playerName);
        this.serviceName = playerName;
      }
    }
  }

  public async init() {
    console.log("Connecting to media player...");

    if (!this.serviceName) {
      await this.detectMediaPlayer();
    }

    const object = await this.sessionBus.getProxyObject(
      this.serviceName,
      "/org/mpris/MediaPlayer2"
    );
    this.player = await object.getInterface("org.mpris.MediaPlayer2.Player");
    this.playerObjectProperties = await object.getInterface(
      "org.freedesktop.DBus.Properties"
    );
  }

  public async returnSongData() {
    if (this.isUpdating) {
      return false;
    }
    if (this.player === null) {
      await this.init();
    }
    await this.sleep(1000);
    const properties = await this.playerObjectProperties.GetAll(
      "org.mpris.MediaPlayer2.Player"
    );

    if (!properties || !properties.Metadata) {
      console.error("Metadata or properties are undefined:", properties);
      return false; // Early return if Metadata is missing
    }

    const metaData = properties.Metadata.value;

    if (!metaData || !metaData["xesam:title"]) {
      console.error("metaData or xesam:title is undefined:", metaData);
      return false; // Early return if metaData or required properties are missing
    }

    if (metaData["xesam:title"].value !== this.currentId) {
      this.currentId = metaData["xesam:title"].value;

      let thumbnail = null;

      // Inline-Implementierung von encodeImageFromUrl
      const encodeImageFromUrl = async (
        url: string,
        type: "jpeg" | "gif" = "jpeg",
        retries = 3
      ): Promise<string> => {
        try {
          console.log(`Fetching ${type} data from ${url}...`);

          const isLocalFile = url.startsWith("file://");
          const filePath = isLocalFile ? url.replace("file://", "") : url;

          // Fetch image data
          let imageBuffer: Buffer;

          if (isLocalFile) {
            console.log("Processing local file...");
            imageBuffer = await sharp(filePath).toBuffer(); // Load the local file
          } else {
            console.log("Processing remote URL...");
            const response = await fetch(url);

            if (!response.ok) {
              throw new Error(`HTTP error! Status: ${response.status}`);
            }

            imageBuffer = Buffer.from(await response.arrayBuffer()); // Load the remote file
          }

          // Convert the image to the desired format
          const convertedBuffer = await sharp(imageBuffer)
            .toFormat(type)
            .toBuffer();

          // Encode the image to Base64
          return `data:image/${type};base64,${convertedBuffer.toString(
            "base64"
          )}`;
        } catch (error) {
          console.error(`Error encoding image from URL: ${url}`, error);

          // Retry mechanism for transient errors
          if (retries > 0) {
            console.log(`Retrying... Attempts left: ${retries}`);
            return encodeImageFromUrl(url, type, retries - 1);
          }

          throw new Error(
            `Failed to encode image after multiple retries: ${url}`
          );
        }
      };

      // Verwende die inline encodeImageFromUrl-Funktion
      if (metaData["mpris:artUrl"] && metaData["mpris:artUrl"].value) {
        try {
          thumbnail = await encodeImageFromUrl(
            metaData["mpris:artUrl"].value,
            "jpeg"
          );
        } catch (error) {
          console.error("Failed to fetch or convert image:", error);
        }
      }

      const response = {
        type: "song",
        app: "client",
        payload: {
          id: metaData["xesam:title"].value,
          album: metaData["xesam:album"]?.value || "Unknown",
          artist: metaData["xesam:artist"]?.value?.[0] || "Unknown",
          track_name: metaData["xesam:title"].value,
          thumbnail: thumbnail,
          track_length:
            Number(metaData["mpris:length"]?.value / BigInt(1000)) || 0,
          track_progress:
            Number(properties.Position?.value / BigInt(1000)) || 0,
          is_playing: properties.PlaybackStatus?.value === "Playing",
          volume: (properties.Volume?.value || 0) * 100,
          shuffle_state: properties.Shuffle?.value || false,
          repeat_state: properties.LoopStatus?.value || "None",
          can_play: properties.CanPlay?.value || false,
          can_change_volume: true,
          playlist: "Not implemented",
        },
      };

      this.DeskThing.sendDataToClient(response);
    } else {
      if (!this.isUpdating) {
        const response = {
          type: "song",
          app: "client",
          payload: {
            id: metaData["xesam:title"].value,
            is_playing: properties.PlaybackStatus?.value === "Playing",
            volume: (properties.Volume?.value || 0) * 100,
            shuffle_state: properties.Shuffle?.value || false,
            repeat_state: properties.LoopStatus?.value || "None",
            can_play: properties.CanPlay?.value || false,
            can_change_volume: true,
            track_length:
              Number(metaData["mpris:length"]?.value / BigInt(1000)) || 0,
            track_progress:
              Number(properties.Position?.value / BigInt(1000)) || 0,
          },
        };

        this.DeskThing.send(response);
      }
    }
  }

  public async checkForRefresh() {
    await this.returnSongData();
    return;
  }

  public async play() {
    this.setUpdate();
    if (this.player === null) {
      await this.init();
    }
    return await this.player.Play();
  }

  public async pause() {
    this.setUpdate();
    if (this.player === null) {
      await this.init();
    }
    return await this.player.Pause();
  }

  public async next() {
    this.setUpdate();
    if (this.player === null) {
      await this.init();
    }
    return await this.player.Next();
  }

  public async previous() {
    this.setUpdate();
    if (this.player === null) {
      await this.init();
    }
    return await this.player.Previous();
  }

  public async seek(position: number) {
    this.setUpdate();
    if (this.player === null) {
      await this.init();
    }
    console.log(position);
    const trackId = (
      await this.playerObjectProperties.Get(
        "org.mpris.MediaPlayer2.Player",
        "Metadata"
      )
    ).value["mpris:trackid"].value;
    const seek = BigInt(position * 1000);
    return await this.player.SetPosition(trackId, seek);
  }

  public async setVolume(volume: number) {
    this.setUpdate();
    if (this.player === null) {
      await this.init();
    }
    const vol = new dbus.Variant("d",(volume / 100));
    return await this.playerObjectProperties.Set(
      "org.mpris.MediaPlayer2.Player",
      "Volume",
      vol
    );
  }
  public async setRepeat(state: string) {
    this.setUpdate();
    if (this.player === null) {
      await this.init();
    }
    const repeat = new dbus.Variant(
      "s",
      state.charAt(0).toUpperCase() + state.slice(1)
    );
    return await this.playerObjectProperties.Set(
      "org.mpris.MediaPlayer2.Player",
      "LoopStatus",
      repeat
    );
  }

  public async setShuffle(state: boolean) {
    this.setUpdate();
    if (this.player === null) {
      await this.init();
    }
    const shuffle = new dbus.Variant("b", state);
    return await this.playerObjectProperties.Set(
      "org.mpris.MediaPlayer2.Player",
      "Shuffle",
      shuffle
    );
  }
}

export { linuxPlayer };
