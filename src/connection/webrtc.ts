import type { ConnectionCallbacks, ConnectionState, DataChannelMessage, TurnServerInfo } from '../types';

export class WebRTCConnection {
  pc: RTCPeerConnection;
  channel: RTCDataChannel | null = null;
  private callbacks: ConnectionCallbacks;
  private state: ConnectionState = 'disconnected';
  private sendQueue: string[] = [];

  constructor(callbacks: ConnectionCallbacks, turnServer?: TurnServerInfo) {
    this.callbacks = callbacks;

    const config: RTCConfiguration = {
      iceServers: turnServer
        ? [{
            urls: turnServer.realm,
            username: turnServer.user,
            credential: turnServer.passwd,
          }]
        : [],
      bundlePolicy: 'max-bundle',
    };

    console.log('[go2:rtc] Creating RTCPeerConnection', config);
    this.pc = new RTCPeerConnection(config);
    this.setupPeerConnection();
  }

  private setupPeerConnection(): void {
    this.pc.addTransceiver('video', { direction: 'recvonly' });
    this.pc.addTransceiver('audio', { direction: 'sendrecv' });

    this.channel = this.pc.createDataChannel('data', {
      ordered: true,
    });

    this.channel.binaryType = 'arraybuffer';
    this.setupChannelHandlers(this.channel);

    // Also handle data channels created by the robot (remote peer)
    this.pc.ondatachannel = (event) => {
      console.log('[go2:rtc] Remote data channel received:', event.channel.label);
      event.channel.binaryType = 'arraybuffer';
      this.setupChannelHandlers(event.channel);
      // Use the remote channel for sending too if our channel isn't open
      if (!this.channel || this.channel.readyState !== 'open') {
        this.channel = event.channel;
      }
    };

    this.pc.ontrack = (event) => {
      console.log(`[go2:rtc] Track received: ${event.track.kind}`);
      if (event.track.kind === 'video') {
        this.callbacks.onVideoTrack(event.streams[0] ?? new MediaStream([event.track]));
      } else if (event.track.kind === 'audio') {
        this.callbacks.onAudioTrack(event.streams[0] ?? new MediaStream([event.track]));
      }
    };

    this.pc.onicecandidate = (event) => {
      if (event.candidate) {
        console.log('[go2:rtc] ICE candidate:', event.candidate.candidate);
      }
    };

    this.pc.oniceconnectionstatechange = () => {
      console.log('[go2:rtc] ICE connection state:', this.pc.iceConnectionState);
    };

    this.pc.onconnectionstatechange = () => {
      const pcState = this.pc.connectionState;
      console.log('[go2:rtc] Connection state:', pcState);
      if (pcState === 'failed' || pcState === 'closed') {
        this.setState('failed');
      } else if (pcState === 'connecting') {
        this.setState('connecting');
      }
      // Don't setState('connected') here — wait for data channel onopen
      // Firefox opens the data channel later than Chrome, causing validation
      // to fire before the channel is ready to send.
    };

    this.pc.onsignalingstatechange = () => {
      console.log('[go2:rtc] Signaling state:', this.pc.signalingState);
    };
  }

  private setupChannelHandlers(channel: RTCDataChannel): void {
    channel.onopen = () => {
      console.log('[go2:rtc] Data channel OPEN:', channel.label);
      this.setState('connected');
      // Flush any messages queued while channel was connecting
      if (this.sendQueue.length > 0) {
        console.log(`[go2:rtc] Flushing ${this.sendQueue.length} queued messages`);
        for (const msg of this.sendQueue) {
          channel.send(msg);
        }
        this.sendQueue = [];
      }
    };

    channel.onclose = () => {
      console.log('[go2:rtc] Data channel CLOSED:', channel.label);
      this.setState('disconnected');
    };

    channel.onerror = (event) => {
      console.error('[go2:rtc] Data channel error:', event);
    };

    channel.onmessage = (event) => {
      this.handleChannelMessage(event.data);
    };
  }

  private parseJsonMessage(raw: string): void {
    // Extract JSON substring — handles null bytes, BOM, and any surrounding garbage
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start < 0 || end <= start) return;
    try {
      const msg: DataChannelMessage = JSON.parse(raw.substring(start, end + 1));
      this.callbacks.onMessage(msg);
    } catch {
      // genuinely malformed JSON
    }
  }

  private handleChannelMessage(data: ArrayBuffer | string): void {
    if (typeof data === 'string') {
      this.parseJsonMessage(data);
      return;
    }

    if (data.byteLength < 4) return;

    const view = new DataView(data);
    const h1 = view.getUint16(0, true);
    const h2 = view.getUint16(2, true);

    // Type 2 LiDAR binary frame: [uint16=2][uint16=0][uint32 jsonLen][4 padding][JSON][binary payload]
    // Layout: bytes 0-3=header, 4-7=jsonLen, 8-11=padding, 12+=JSON, 12+jsonLen+=binary
    if (h1 === 2 && h2 === 0 && data.byteLength >= 12) {
      this.parseBinaryFramedMessage(data, 12, view.getUint32(4, true));
      return;
    }

    // Normal binary framed: [uint16 jsonLen][uint16 reserved][JSON][optional binary payload]
    // Check if h1 looks like a plausible JSON length (not too large, not zero)
    if (h1 > 0 && h1 < 60000 && 4 + h1 <= data.byteLength) {
      // Try to parse as framed message with JSON header at offset 4
      const jsonBytes = new Uint8Array(data, 4, h1);
      const jsonStr = new TextDecoder().decode(jsonBytes);
      if (jsonStr.indexOf('{') >= 0) {
        this.parseBinaryFramedMessage(data, 4, h1);
        return;
      }
    }

    // Fallback: try entire buffer as JSON string
    const bytes = new Uint8Array(data);
    let end = bytes.length;
    while (end > 0 && bytes[end - 1] === 0) end--;
    if (end === 0) return;

    const fullStr = new TextDecoder().decode(bytes.subarray(0, end));
    if (fullStr.indexOf('{') >= 0) {
      this.parseJsonMessage(fullStr);
    }
  }

  /** Parse a binary framed message: JSON header + optional binary payload. */
  private parseBinaryFramedMessage(data: ArrayBuffer, jsonStart: number, jsonLen: number): void {
    if (jsonLen <= 0 || jsonStart + jsonLen > data.byteLength) return;

    const jsonBytes = new Uint8Array(data, jsonStart, jsonLen);
    const jsonStr = new TextDecoder().decode(jsonBytes);

    const start = jsonStr.indexOf('{');
    const end = jsonStr.lastIndexOf('}');
    if (start < 0 || end <= start) return;

    try {
      const msg: DataChannelMessage = JSON.parse(jsonStr.substring(start, end + 1));

      // Attach any binary payload after the JSON header to data.data
      const payloadStart = jsonStart + jsonLen;
      if (payloadStart < data.byteLength) {
        const binaryPayload = data.slice(payloadStart);
        if (binaryPayload.byteLength > 0 && msg.data && typeof msg.data === 'object') {
          (msg.data as Record<string, unknown>).data = binaryPayload;
        }
      }

      this.callbacks.onMessage(msg);
    } catch {
      // malformed JSON
    }
  }

  private setState(state: ConnectionState): void {
    if (this.state !== state) {
      console.log(`[go2:rtc] State: ${this.state} → ${state}`);
      this.state = state;
      this.callbacks.onStateChange(state);
    }
  }

  async createOffer(): Promise<string> {
    this.setState('connecting');
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    console.log('[go2:rtc] Local description set, gathering ICE candidates...');

    await new Promise<void>((resolve) => {
      if (this.pc.iceGatheringState === 'complete') {
        resolve();
        return;
      }
      this.pc.onicegatheringstatechange = () => {
        if (this.pc.iceGatheringState === 'complete') {
          console.log('[go2:rtc] ICE gathering complete');
          resolve();
        }
      };
    });

    return this.pc.localDescription!.sdp;
  }

  async setAnswer(sdp: string): Promise<void> {
    console.log('[go2:rtc] Setting remote description (answer)...');
    await this.pc.setRemoteDescription({
      type: 'answer',
      sdp,
    });
    console.log('[go2:rtc] Remote description set successfully');
  }

  send(msg: DataChannelMessage): void {
    const str = JSON.stringify(msg);
    if (this.channel?.readyState === 'open') {
      this.channel.send(str);
    } else {
      // Queue message — will be flushed when channel opens (fixes Firefox timing)
      console.log('[go2:rtc] Channel not open yet, queuing message');
      this.sendQueue.push(str);
    }
  }

  close(): void {
    console.log('[go2:rtc] Closing connection');
    this.channel?.close();
    this.pc.close();
    this.setState('disconnected');
  }

  getState(): ConnectionState {
    return this.state;
  }
}
