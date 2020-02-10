/**
 * HiQnet device control library.
 *
 * Copyright (C) 2020 Adam Nielsen <malvineous@shikadi.net>
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

const debug = require('debug')('hiqnet:hiqnet');
const { DeviceError } = require('./error.js');

const commands = {
	// Device-level methods
	getAttributes:         0x010D,
	getVDList:             0x011A,
	store:                 0x0124,
	recall:                0x0125,
	locate:                0x0129,

	eventLogSubscribe:     0x0115,
	eventLogUnsubscribe:   0x012B,
	eventLogRequest:       0x012C,

	multiParamSet:         0x0100,
	multiParamGet:         0x0103,
	multiParamSubscribe:   0x010F,
	multiParamUnsubscribe: 0x0112,
	multiObjectParamSet:   0x0101,
	paramSetPercent:       0x0102,
	paramSubscribePercent: 0x0111,

	// Routing-layer messages
	discoInfo:             0x0000,
	reserved1:             0x0001,
	getNetworkInfo:        0x0002,
	reserved3:             0x0003,
	requestAddress:        0x0004,
	addressUsed:           0x0005,
	setAddress:            0x0006,
	goodbye:               0x0007,
	hello:                 0x0008,
};

// Error codes from Third Party Programmer Documentation page 34/35.
// Each error code has a small explanation there.
const errorCodes = {
	invalidVersion:            0x0001,
	invalidLength:             0x0002,
	invalidVirtualDevice:      0x0003,
	invalidObject:             0x0004,
	invalidParameter:          0x0005,
	invalidMessageID:          0x0006,
	invalidValue:              0x0007,
	resourceUnavailable:       0x0008,
	unsupported:               0x0009,
	invalidVirtualDeviceClass: 0x000A,
	invalidObjectClass:        0x000B,
	invalidParameterClass:     0x000C,
	invalidAttributeID:        0x000D,
	invalidDataType:           0x000E,
	invalidConfiguration:      0x000F,
	flashError:                0x0010,
	notARouter:                0x0011,
};

function getCommandName(c)
{
	const commandId = parseInt(c);
	let commandName = 'unknown';
	for (const i of Object.keys(commands)) {
		if (commands[i] === commandId) {
			commandName = i;
			break;
		}
	}
	return `${commandName}(0x${commandId.toString(16)})`;
}

function getErrorName(c)
{
	const errorCode = parseInt(c);
	let errorName = 'unknown';
	for (const i of Object.keys(errorCodes)) {
		if (errorCodes[i] === errorCode) {
			errorName = i;
			break;
		}
	}
	return `${errorName}(0x${errorCode.toString(16)})`;
}

class HiQnet
{
	constructor(transport, cbUnsolicitedMessage)
	{
		this.transport = transport;
		this.transport.callback = msg => this.recv(msg);

		this.cbUnsolicitedMessage = cbUnsolicitedMessage;

		this.pendingMessages = [];

		// TODO: Negotiate a device ID on the network or let the user pick one.
		this.deviceId = 0x1234;
	}

	send(msg)
	{
		return new Promise(async (resolve, reject) => {
			const version = 2, lenHeader = 0x19;

			let header = Buffer.alloc(lenHeader);
			header.writeUInt8(version, 0);
			header.writeUInt8(lenHeader, 1);
			header.writeUInt32BE(lenHeader + (msg.payload && msg.payload.length || 0), 2);

			header.writeUInt16BE(msg.addrSource.device, 6);
			header.writeUInt8(msg.addrSource.virtualDevice, 8);
			header.writeUInt8(msg.addrSource.object[0], 9);
			header.writeUInt8(msg.addrSource.object[1], 10);
			header.writeUInt8(msg.addrSource.object[2], 11);
			//header.writeUInt8(msg.addrSource.object >> 16, 9);
			//header.writeUInt16BE(msg.addrSource.object & 0xFFFF, 10);

			header.writeUInt16BE(msg.addrDest.device, 12);
			header.writeUInt8(msg.addrDest.virtualDevice, 14);
			header.writeUInt8(msg.addrDest.object[0], 15);
			header.writeUInt8(msg.addrDest.object[1], 16);
			header.writeUInt8(msg.addrDest.object[2], 17);
			//header.writeUInt8(msg.addrDest.object >> 16, 15);
			//header.writeUInt16BE(msg.addrDest.object & 0xFFFF, 16);

			header.writeUInt16BE(msg.cmd, 18);
			header.writeUInt16BE(msg.flags || 0, 20);
			header.writeUInt8(msg.hopCount || 5, 22);
			header.writeUInt16BE(msg.seqNum || 0, 23);

			const tx = msg.payload && Buffer.concat([header, msg.payload]) || header;

			if (debug.enabled) {
				// Decode the message again so we can be sure of what we're sending.
				const outHeader = this.decodeHeader(tx);
				const outPayload = tx.slice(outHeader.lenHeader);
				const msgDecoded = this.decode(outHeader, outPayload);
				debug(`Sending ${getCommandName(msgDecoded.header.cmd)}:`, msgDecoded);
			}

			this.pendingMessages.push({
				cmd: msg.cmd,
				handler: reply => {
					resolve(reply);
				},
			});

			try {
				await this.transport.sendMessage(tx);
			} catch (e) {
				reject(e);
			}
		});
	}

	decodeHeader(msg)
	{
		let header = {
			version: msg.readUInt8(0),
			lenHeader: msg.readUInt8(1),
			lenPayload: msg.readUInt32BE(2),
			addrSource: {
				device: msg.readUInt16BE(6),
				virtualDevice: msg.readUInt8(8),
				object: (msg.readUInt8(9) << 16) | msg.readUInt16BE(10),
			},
			addrDest: {
				device: msg.readUInt16BE(12),
				virtualDevice: msg.readUInt8(14),
				object: (msg.readUInt8(15) << 16) | msg.readUInt16BE(16),
			},
			cmd: msg.readUInt16BE(18),
			flagsValue: msg.readUInt16BE(20),
			flags: {},
			hopCount: msg.readUInt8(22),
			seqNum: msg.readUInt16BE(23),
		};

		if (header.flagsValue & (1 << 0)) header.flags.requestAck = true;
		if (header.flagsValue & (1 << 1)) header.flags.ack = true;
		if (header.flagsValue & (1 << 2)) header.flags.info = true;
		if (header.flagsValue & (1 << 3)) header.flags.error = true;
		if (header.flagsValue & (1 << 5)) header.flags.guaranteed = true;
		if (header.flagsValue & (1 << 6)) header.flags.multipart = true;
		if (header.flagsValue & (1 << 8)) header.flags.session = true;

		let endHeader = 25;
		if (header.flags.error && (header.lenHeader >= 29)) {
			header.error = {
				code: msg.readUInt16BE(25),
				text: null,
			};
			header.error.codeName = getErrorName(header.error.code);

			let strlen = msg.readUInt16BE(27);
			if (strlen > 2) {
				header.error.text = msg.slice(29, 29 + strlen - 2).swap16().toString('utf16le');
			}

			endHeader = 29 + strlen;
		}

		if (header.flags.multipart && (header.lenHeader >= 31)) {
			header.multipart = {
				startSeqNum: msg.readUInt16BE(25),
				bytesRemaining: msg.readUInt32BE(27),
			};
			endHeader = 31;
		}

		if (header.lenHeader > endHeader) {
			// Leftover data we didn't process
			header.extra = msg.slice(endHeader, header.lenHeader);
		}

		return header;
	}

	recv(msg)
	{
		const header = this.decodeHeader(msg);
		const payload = msg.slice(header.lenHeader);

		let msgDecoded;
		if (header.flags.error) {
			msgDecoded = {
				header: header,
				payload: payload,
			};

		} else {
			// No error so decode normally.
			msgDecoded = this.decode(header, payload);
		}

		let handled = false;
		this.pendingMessages = this.pendingMessages.filter(pendingMsg => {
			if (pendingMsg.cmd === header.cmd) {
				handled = true;
				pendingMsg.handler(msgDecoded);
				return false; // remove pending message
			}
			return true; // keep message for later
		});

		if (handled) return;

		if (this.cbUnsolicitedMessage) this.cbUnsolicitedMessage(msgDecoded);
	}

	decode(header, payload)
	{
		//debug('decode()', header, payload);

		let msg = {
			header: header,
		};

		switch (header.cmd) {
			case commands.discoInfo:
				const lenSerial = payload.readUInt16BE(3);
				const posPostSerial = 5 + lenSerial;

				msg.discoInfo = {
					senderDeviceAddress: payload.readUInt16BE(0),
					routeCost: payload.readUInt8(2),
					serial: Array.from(payload.slice(5, posPostSerial))
						.map(s => s.toString(16).padStart(2, '0'))
						.join('-'),
					maxMessageLen: payload.readUInt32BE(posPostSerial),
					keepAlivePeriod: payload.readUInt16BE(posPostSerial + 4),

					// 1 == IP, 4 == RS232, 5 == USB
					networkId: payload.readUInt8(posPostSerial + 6),

					// USB: Seems to be nine 0x00 bytes
					networkInfo: payload.slice(posPostSerial + 7, payload.length),
				};
				break;
			case commands.addressUsed:
				msg.addressUsed = {
				};
				break;
			case commands.multiParamGet:
				if (msg.header.flags.info) { // response
					msg.multiParamGet = {
						parameters: {},
					};
					const paramCount = payload.readUInt16BE(0);
					let pos = 2;
					for (let i = 0; i < paramCount; i++) {
						const paramId = payload.readUInt16BE(pos);
						pos += 2;
						const dataType = payload.readUInt8(pos);
						pos++;
						let value;
						switch (dataType) {
							case 0: // int8
								value = payload.readInt8(pos);
								pos++;
								break;

							case 1: // uint8
								value = payload.readUInt8(pos);
								pos++;
								break;

							case 2: // int16be
								value = payload.readInt16BE(pos);
								pos += 2;
								break;

							case 3: // uint16be
								value = payload.readUInt16BE(pos);
								pos += 2;
								break;

							case 4: // int32be
								value = payload.readInt32BE(pos);
								pos += 4;
								break;

							case 5: // uint32be
								value = payload.readUInt32BE(pos);
								pos += 4;
								break;

							case 6: // float
								value = payload.readFloatBE(pos);
								pos += 4;
								break;

							case 7: // double
								value = payload.readDoubleBE(pos);
								pos += 8;
								break;

							case 8: { // block
								let len = payload.readUInt16BE(pos);
								pos += 2;
								value = payload.slice(pos, pos + len);
								pos += len;
								break;
							}

							case 9: { // string
								let len = payload.readUInt16BE(pos);
								pos += 2;
								if (len > 2) {
									value = payload.slice(pos, pos + len - 2).swap16().toString('utf16le');
								} else {
									value = '';
								}
								pos += len;
								break;
							}

							case 10: // int64be
								value = payload.readBigInt64BE(pos);
								pos += 8;
								break;

							case 11: // uint64be
								value = payload.readBigUInt64BE(pos);
								pos += 8;
								break;

							default:
								throw new Error(`Unknown data type: ${dataType}`);
						}
						msg.multiParamGet.parameters[paramId] = value;
					}

				} else { // request
					msg.multiParamGet = {
						parameters: [],
					};
					const paramCount = payload.readUInt16BE(0);
					for (let i = 0; i < paramCount; i++) {
						const p = payload.readUInt16BE(2 + i * 2);
						msg.multiParamGet.parameters.push(p);
					}
				}
				break;
			default:
				debug(`Message ${getCommandName(header.cmd)} not implemented yet!`);
				msg.payload = payload;
				break;
		}

		return msg;
	}

	/**
	 * Flash device LEDs for identification purposes.
	 *
	 * @param Number msTime
	 *   Number of milliseconds to flash LEDs for.  0xFFFF means forever, 0 means
	 *   stop flashing immediately.
	 */
	locate(deviceId, msTime)
	{
		let payload = Buffer.alloc(2);
		payload.writeUInt16BE(msTime, 0);

		return this.send({
			cmd: commands.locate,
			addrSource: {
				device: this.deviceId,
				virtualDevice: 0,
				object: [0, 0, 0],
			},
			addrDest: {
				device: deviceId,
				virtualDevice: 0,
				object: [0, 0, 0],
			},
			payload: payload,
		});
	}

	/**
	 * Find out whether the address is in use on the HiQnet network.
	 *
	 * @param Number deviceId
	 *   The ID of the device to check.
	 *
	 * @return Unknown - lacking access to a device that supports this command.
	 */
	async addressUsed(deviceId)
	{
		const r = await this.send({
			cmd: commands.addressUsed,
			addrSource: {
				device: deviceId,
				virtualDevice: 0,
				object: 0,
			},
			addrDest: {
				device: 0xFFFF,
				virtualDevice: 0,
				object: 0,
			},
		});
		if (r.header.flags.error) {
			throw new DeviceError(r);
		}
		// TODO: Decode the response
		return r;
	}

	/**
	 * @param HiQNetAddress address
	 *   Device to contact and object to query.
	 *
	 * @param Array parameters
	 *   List of one or more parameters within the object to query.
	 *
	 * @return Object, keys are items from the `parameters` array, values are the
	 *   data returned from the device.
	 */
	async multiParamGet(address, parameters)
	{
		let payload = Buffer.alloc(2 + parameters.length * 2);
		payload.writeUInt16BE(parameters.length, 0);
		for (let i = 0; i < parameters.length; i++) {
			payload.writeUInt16BE(parameters[i], 2 + i * 2);
		}
		const r = await this.send({
			cmd: commands.multiParamGet,
			addrSource: {
				device: this.deviceId,
				virtualDevice: 0,
				object: [0, 0, 0],
			},
			addrDest: address,
			payload: payload,
		});
		if (r.header.flags.error) {
			throw new DeviceError(r);
		}

		let values = {};
		for (const id of parameters) {
			values[id] = r.multiParamGet.parameters[id];
		}

		return values;
	}
};

module.exports = HiQnet;
